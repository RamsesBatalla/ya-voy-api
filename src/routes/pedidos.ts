import { Router } from "express"
import { sql } from "../db"
import { sendPushToUser } from "../firebase"
import { notificarCliente } from "../websocket"
import { requireAuth } from "../middleware/auth"
import { logError } from "../logger"
import { invalidateCache } from "../cache"

// Transiciones válidas por rol restaurante
const TRANS_RESTAURANTE: Record<string, string[]> = {
  pendiente_pago:    [],
  nuevo:             ["preparando", "cancelado"],
  preparando:        ["listo", "cancelado"],
  listo:             ["cancelado"],
  en_camino:         [],
  esperando_cliente: [],
  entregado:         [],
  cancelado:         [],
  pago_fallido:      ["cancelado"],
}

const router = Router()

const initFotoCols = async () => {
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS foto_entrega TEXT`
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entregado_en TIMESTAMPTZ`
  await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS deuda_efectivo NUMERIC DEFAULT 0`
}
initFotoCols().catch(e => console.error("Error init foto cols:", e.message))

router.get("/:negocioId/pedidos", requireAuth, async (req, res) => {
  try {
    const authUserId = (req as any).userId
    const ownerCheck = await sql`SELECT id FROM viveres WHERE id = ${req.params.negocioId} AND owner_id = ${authUserId}`
    if (!ownerCheck.length) return res.status(403).json({ error: "No autorizado" })

    const rows = await sql`
      SELECT * FROM pedidos
      WHERE negocio_id = ${req.params.negocioId}
        AND status != 'pendiente_pago'
      ORDER BY creado_en DESC LIMIT 500`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.patch("/pedidos/:id/status", requireAuth, async (req, res) => {
  try {
    const authUserId = (req as any).userId
    const { status } = req.body
    const current = await sql`
      SELECT p.status, v.owner_id FROM pedidos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.id = ${req.params.id}`
    if (!current.length) return res.status(404).json({ error: "Pedido no encontrado" })
    if (current[0].owner_id !== authUserId) return res.status(403).json({ error: "No autorizado" })
    const estadoActual = current[0].status
    if (!TRANS_RESTAURANTE[estadoActual]?.includes(status))
      return res.status(400).json({ error: `No se puede pasar de '${estadoActual}' a '${status}'` })

    const rows = await sql`
      UPDATE pedidos SET status = ${status},
        entregado_en = CASE WHEN ${status} = 'entregado' THEN NOW() ELSE entregado_en END
      WHERE id = ${req.params.id} RETURNING *`
    const pedido = rows[0]
    if (!pedido) return res.status(404).json({ error: "Pedido no encontrado" })
    res.json(pedido)

    if (pedido.cliente_id) notificarCliente(pedido.cliente_id, "pedido_update", pedido)

    const negocio = await sql`SELECT owner_id, nombre FROM viveres WHERE id = ${pedido.negocio_id}`
    const ownerID = negocio[0]?.owner_id
    const negNombre = negocio[0]?.nombre || "el restaurante"

    if (status === "nuevo" && ownerID) {
      notificarCliente(ownerID, "nuevo_pedido", pedido)
      await sendPushToUser(sql, ownerID, "Nuevo pedido", "Tienes un pedido nuevo en " + negNombre, { pedidoId: pedido.id })
    }
    if (status === "preparando" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "👨‍🍳 Preparando tu pedido", negNombre + " aceptó tu pedido y lo está preparando", { pedidoId: pedido.id, status: "preparando" }).catch(() => {})
    }
    if (status === "listo" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "✅ Tu pedido está listo", negNombre + " terminó de preparar tu pedido", { pedidoId: pedido.id, status: "listo" }).catch(() => {})
    }
    if (status === "en_camino" && pedido.cliente_id) {
      const eta = pedido.tiempo_estimado ? ` (${pedido.tiempo_estimado})` : ""
      await sendPushToUser(sql, pedido.cliente_id, "🛵 Tu pedido va en camino", `El repartidor está en camino${eta}`, { pedidoId: pedido.id, status: "en_camino" }).catch(() => {})
    }
    if (status === "esperando_cliente" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "📍 El repartidor llegó", "Tu repartidor está esperando en la dirección indicada", { pedidoId: pedido.id, status: "esperando_cliente" }).catch(() => {})
    }
    if (status === "entregado" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "🎉 Pedido entregado", "¡Que lo disfrutes! No olvides calificar tu experiencia", { pedidoId: pedido.id, status: "entregado" }).catch(() => {})
    }

    if (status === "entregado" && pedido.repartidor_id) {
      try {
        const cfgRow = await sql`SELECT valor FROM app_config WHERE clave = 'comision_pct'`
        const comisionPct = cfgRow.length ? parseFloat(cfgRow[0].valor) / 100 : 0.18
        const comision = Math.round(Number(pedido.total || 0) * comisionPct * 100) / 100
        if (pedido.metodo_pago === "efectivo") {
          await sql`UPDATE repartidores SET deuda_efectivo = COALESCE(deuda_efectivo, 0) + ${comision} WHERE id = ${pedido.repartidor_id}`
        } else if (pedido.metodo_pago === "tarjeta") {
          await sql`UPDATE repartidores SET deuda_efectivo = GREATEST(0, COALESCE(deuda_efectivo, 0) - ${comision}) WHERE id = ${pedido.repartidor_id}`
        }
      } catch (e: any) { logError(e, "comision:entregado") }
    }

    // Notificar a repartidores disponibles tanto cuando pasa a "preparando" como cuando pasa a "listo"
    if (status === "preparando" || status === "listo") {
      if (pedido.repartidor_id) {
        notificarCliente(pedido.repartidor_id, "pedido_update", pedido)
        if (status === "listo") {
          await sendPushToUser(sql, pedido.repartidor_id, "🍽️ ¡Pedido listo para recoger!", `El pedido en ${negNombre} ya está listo. Recuerda verificar la palabra clave con el restaurante.`, { pedidoId: String(pedido.id), status: "listo" }).catch(() => {})
        }
      } else {
        const repartidoresOnline = await sql`SELECT id FROM repartidores WHERE status = 'online' OR en_linea = true`
        for (const r of repartidoresOnline) {
          notificarCliente(r.id, "pedido_disponible", { ...pedido, negocio_nombre: negNombre })
          const tituloPush = status === "preparando" ? "🛵 Nuevo pedido disponible" : "🍽️ Pedido listo para recoger"
          const cuerpoPush = status === "preparando"
            ? `${negNombre} está preparando un pedido ($${Number(pedido.costo_envio || 25).toFixed(0)} envío). ¡Acéptalo ahora!`
            : `Hay un pedido listo para recoger en ${negNombre}`
          await sendPushToUser(sql, r.id, tituloPush, cuerpoPush, { pedidoId: String(pedido.id), tipo: "pedido_disponible" }).catch(() => {})
        }
      }
    }

    if (status === "cancelado") {
      if (pedido.cliente_id) {
        await sendPushToUser(sql, pedido.cliente_id, "Pedido cancelado", "Tu pedido fue cancelado", { pedidoId: pedido.id, status: "cancelado" }).catch(() => {})
      }
      if (pedido.repartidor_id) {
        notificarCliente(pedido.repartidor_id, "pedido_update", pedido)
        await sendPushToUser(sql, pedido.repartidor_id, "Pedido cancelado", `El pedido de ${negNombre} fue cancelado`, { pedidoId: pedido.id, status: "cancelado" }).catch(() => {})
      }
    }
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.patch("/pedidos/:id/rechazar", requireAuth, async (req, res) => {
  try {
    const authUserId = (req as any).userId
    const { razon } = req.body
    const rows = await sql`
      UPDATE pedidos SET status = 'cancelado', cancelado_en = NOW(), razon_cancelacion = ${razon || 'Rechazado por el restaurante'}
      WHERE id = ${req.params.id} AND status = 'nuevo'
        AND negocio_id IN (SELECT id FROM viveres WHERE owner_id = ${authUserId} OR user_id = ${authUserId})
      RETURNING cliente_id, negocio_id`
    if (!rows.length) return res.status(400).json({ error: "Pedido no encontrado o no autorizado" })
    const { cliente_id } = rows[0]
    if (cliente_id) {
      notificarCliente(cliente_id, "pedido_update", { id: req.params.id, status: "cancelado", razon_cancelacion: razon || "Rechazado por el restaurante" })
      await sendPushToUser(sql, cliente_id, "Pedido rechazado", razon || "El restaurante no pudo aceptar tu pedido", { pedidoId: req.params.id }).catch(() => {})
    }
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.patch("/pedidos/:id/cancelar", requireAuth, async (req, res) => {
  try {
    const authUserId = (req as any).userId
    const rows = await sql`
      SELECT p.status, p.cliente_id, p.repartidor_id, COALESCE(v.owner_id, v.user_id) as owner_id FROM pedidos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.id = ${req.params.id}`
    if (!rows.length) return res.status(404).json({ error: "Pedido no encontrado" })
    if (rows[0].owner_id !== authUserId) return res.status(403).json({ error: "No autorizado" })
    const { status, cliente_id, repartidor_id } = rows[0]
    if (!["nuevo", "preparando"].includes(status))
      return res.status(400).json({ error: "No se puede cancelar en este punto" })
    await sql`UPDATE pedidos SET status = ${"cancelado"}, cancelado_en = NOW(), razon_cancelacion = 'Cancelado por el restaurante' WHERE id = ${req.params.id}`
    if (cliente_id) {
      notificarCliente(cliente_id, "pedido_update", { id: req.params.id, status: "cancelado" })
      await sendPushToUser(sql, cliente_id, "Pedido cancelado", "El restaurante canceló tu pedido", { pedidoId: req.params.id }).catch(() => {})
    }
    if (repartidor_id) {
      notificarCliente(repartidor_id, "pedido_update", { id: req.params.id, status: "cancelado" })
      await sendPushToUser(sql, repartidor_id, "Pedido cancelado", "El restaurante canceló el pedido", { pedidoId: req.params.id }).catch(() => {})
    }
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post("/pedidos/:id/foto-entrega", requireAuth, async (req, res) => {
  try {
    const authUserId = (req as any).userId
    const { fotoUrl } = req.body
    if (!fotoUrl) return res.status(400).json({ error: "fotoUrl requerida" })
    const check = await sql`
      SELECT p.id, p.cliente_id, p.repartidor_id, COALESCE(v.owner_id, v.user_id) as owner_id
      FROM pedidos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.id::text = ${req.params.id}
        AND (v.owner_id = ${authUserId} OR v.user_id = ${authUserId} OR p.repartidor_id = ${authUserId})`
    if (!check.length) return res.status(403).json({ error: "No autorizado" })
    const rows = await sql`
      UPDATE pedidos
      SET foto_entrega = ${fotoUrl},
          foto_entrega_url = ${fotoUrl},
          foto_entrega_expira = NOW() + INTERVAL '24 hours'
      WHERE id::text = ${req.params.id}
      RETURNING *`
    if (!rows.length) return res.status(404).json({ error: "Pedido no encontrado" })
    if (rows[0].cliente_id) notificarCliente(rows[0].cliente_id, "pedido_update", rows[0])
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
