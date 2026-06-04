import { Router } from "express"
import { sql } from "../db"
import { sendPushToUser } from "../firebase"
import { notificarCliente } from "../websocket"

const router = Router()

const initFotoCols = async () => {
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS foto_entrega TEXT`
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entregado_en TIMESTAMPTZ`
  await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS deuda_efectivo NUMERIC DEFAULT 0`
}
initFotoCols().catch(e => console.error("Error init foto cols:", e.message))

router.get("/:negocioId/pedidos", async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM pedidos WHERE negocio_id = ${req.params.negocioId}
      ORDER BY creado_en DESC LIMIT 500`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.patch("/pedidos/:id/status", async (req, res) => {
  try {
    const { status } = req.body
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
      await sendPushToUser(sql, ownerID, "Nuevo pedido", "Tienes un pedido nuevo en " + negNombre, { pedidoId: pedido.id })
    }
    if (status === "preparando" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "Preparando tu pedido", negNombre + " esta preparando tu orden", { pedidoId: pedido.id })
    }
    if (status === "en_camino" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "Tu pedido va en camino", "El repartidor esta llevando tu pedido", { pedidoId: pedido.id })
    }
    if (status === "esperando_cliente" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "El repartidor llego", "Tu repartidor esta esperando en la direccion indicada", { pedidoId: pedido.id })
    }
    if (status === "entregado" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "Pedido entregado", "Que lo disfrutes! No olvides calificar tu experiencia", { pedidoId: pedido.id })
    }

    // Tracking de comisión efectivo/tarjeta por repartidor
    if (status === "entregado" && pedido.repartidor_id) {
      try {
        const cfgRow = await sql`SELECT valor FROM app_config WHERE clave = 'comision_pct'`
        const comisionPct = cfgRow.length ? parseFloat(cfgRow[0].valor) / 100 : 0.18
        const comision = Math.round(Number(pedido.total || 0) * comisionPct * 100) / 100
        if (pedido.metodo_pago === "efectivo") {
          // El repartidor cobró el efectivo completo, le debe la comisión a la app
          await sql`UPDATE repartidores SET deuda_efectivo = COALESCE(deuda_efectivo, 0) + ${comision} WHERE id = ${pedido.repartidor_id}`
        } else if (pedido.metodo_pago === "tarjeta") {
          // La comisión ya llega a la app; se descuenta de la deuda pendiente si la hay
          await sql`UPDATE repartidores SET deuda_efectivo = GREATEST(0, COALESCE(deuda_efectivo, 0) - ${comision}) WHERE id = ${pedido.repartidor_id}`
        }
      } catch {}
    }
    if (status === "cancelado" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "Pedido cancelado", "Tu pedido fue cancelado", { pedidoId: pedido.id })
    }
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.patch("/pedidos/:id/cancelar", async (req, res) => {
  try {
    const rows = await sql`SELECT status, cliente_id FROM pedidos WHERE id = ${req.params.id}`
    if (!rows.length) return res.status(404).json({ error: "Pedido no encontrado" })
    const { status, cliente_id } = rows[0]
    if (!["nuevo", "preparando"].includes(status))
      return res.status(400).json({ error: "No se puede cancelar en este punto" })
    await sql`UPDATE pedidos SET status = ${"cancelado"}, cancelado_en = NOW() WHERE id = ${req.params.id}`
    if (cliente_id) {
      notificarCliente(cliente_id, "pedido_update", { id: req.params.id, status: "cancelado" })
      await sendPushToUser(sql, cliente_id, "Pedido cancelado", "El restaurante cancelo tu pedido", { pedidoId: req.params.id })
    }
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/negocios/pedidos/:id/foto-entrega
router.post("/pedidos/:id/foto-entrega", async (req, res) => {
  try {
    const { fotoUrl } = req.body
    if (!fotoUrl) return res.status(400).json({ error: "fotoUrl requerida" })
    const rows = await sql`UPDATE pedidos SET foto_entrega = ${fotoUrl} WHERE id = ${req.params.id} RETURNING id`
    if (!rows.length) return res.status(404).json({ error: "Pedido no encontrado" })
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router