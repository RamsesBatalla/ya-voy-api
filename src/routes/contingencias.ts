import { Router } from "express"
import { sql } from "../db"
import { requireAuth, requireAdmin } from "../middleware/auth"
import { logError } from "../logger"
import { notificarBloqueoAdmin, notificarContingenciaAdmin } from "../notificationsAdmin"
import { notificarCliente } from "../websocket"
import { sendPushToUser } from "../firebase"

const router = Router()

const initCols = async () => {
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS incidentes_count INT DEFAULT 0`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS suspendido BOOLEAN DEFAULT false`
  await sql`CREATE TABLE IF NOT EXISTS contingencias (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo TEXT NOT NULL,
    pedido_id TEXT,
    repartidor_id TEXT,
    cliente_id TEXT,
    negocio_id TEXT,
    foto_url TEXT,
    descripcion TEXT,
    status TEXT DEFAULT 'pendiente',
    monto_fondo NUMERIC DEFAULT 0,
    creado_en TIMESTAMPTZ DEFAULT NOW(),
    resuelto_en TIMESTAMPTZ,
    nota_admin TEXT
  )`
}
initCols().catch(e => console.error("Error init contingencias:", e.message))

router.get("/", requireAdmin, async (_req, res) => {
  try {
    const rows = await sql`SELECT * FROM contingencias ORDER BY creado_en DESC LIMIT 200`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post("/no-pago", requireAuth, async (req, res) => {
  try {
    const { pedidoId, repartidorId, descripcion } = req.body
    if (!pedidoId || !repartidorId) return res.status(400).json({ error: "pedidoId y repartidorId requeridos" })

    const pedidos = await sql`SELECT * FROM pedidos WHERE id::text = ${pedidoId}`
    if (!pedidos.length) return res.status(404).json({ error: "Pedido no encontrado" })
    const pedido = pedidos[0]

    // Validar ventana de 24h
    if (pedido.entregado_en) {
      const diffHrs = (Date.now() - new Date(pedido.entregado_en).getTime()) / 1000 / 3600
      if (diffHrs > 24) return res.status(400).json({ error: "El plazo de reporte de 24 horas ha vencido para este pedido" })
    }

    if (pedido.cliente_id) {
      const [cliInfo] = await sql`SELECT nombre, email, telefono FROM usuarios WHERE id = ${pedido.cliente_id} LIMIT 1`.catch(() => [])
      const razon = descripcion || "No pago en efectivo — reporte de repartidor"
      await sql`UPDATE usuarios SET bloqueado = true, bloqueado_pendiente = true, razon_bloqueo = ${razon}, bloqueado_en = NOW() WHERE id = ${pedido.cliente_id}`
      await sql`INSERT INTO bloqueos_historial (tipo_usuario, actor_id, razon) VALUES ('usuario', ${pedido.cliente_id}, ${razon})`.catch(e => logError(e, "contingencia:bloqueo_usuario"))
      notificarBloqueoAdmin({
        tipoActor: "cliente",
        actorId: String(pedido.cliente_id),
        nombre: cliInfo?.nombre || "Cliente",
        telefono: cliInfo?.telefono,
        email: cliInfo?.email,
        razon,
        pedidoId: String(pedidoId),
      }).catch(() => {})
    }

    const cfgEnvio = await sql`SELECT valor FROM app_config WHERE clave = 'envio_minimo'`
    const envio = Number(pedido.costo_envio || cfgEnvio[0]?.valor || 25)
    const rows = await sql`
      INSERT INTO contingencias (tipo, pedido_id, repartidor_id, cliente_id, negocio_id, descripcion, monto_fondo)
      VALUES ('no_pago', ${String(pedidoId)}, ${repartidorId}, ${pedido.cliente_id || ""}, ${String(pedido.negocio_id || "")}, ${descripcion || "Cliente se negó a pagar en efectivo"}, ${envio})
      RETURNING *`

    await sql`INSERT INTO fondo_recuperacion (tipo, monto, descripcion, pedido_id)
      VALUES ('uso', ${envio}, ${"Pago envío repartidor por no-pago cliente — pedido " + pedidoId}, ${String(pedidoId)})`.catch(e => logError(e, "contingencia:fondo_nopago"))

    res.json({ ok: true, contingencia: rows[0] })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post("/accidente", requireAuth, async (req, res) => {
  try {
    const { pedidoId, repartidorId, fotoUrl, descripcion } = req.body
    if (!pedidoId || !repartidorId) return res.status(400).json({ error: "pedidoId y repartidorId requeridos" })

    const pedidos = await sql`SELECT * FROM pedidos WHERE id::text = ${pedidoId}`
    if (!pedidos.length) return res.status(404).json({ error: "Pedido no encontrado" })
    const pedido = pedidos[0]

    // Validar ventana de 24h
    if (pedido.entregado_en) {
      const diffHrs = (Date.now() - new Date(pedido.entregado_en).getTime()) / 1000 / 3600
      if (diffHrs > 24) return res.status(400).json({ error: "El plazo de reporte de 24 horas ha vencido para este pedido" })
    }

    const reembolso = Number(pedido.total || 0)

    const rows = await sql`
      INSERT INTO contingencias (tipo, pedido_id, repartidor_id, cliente_id, negocio_id, foto_url, descripcion, monto_fondo)
      VALUES ('accidente', ${String(pedidoId)}, ${repartidorId}, ${pedido.cliente_id || ""}, ${String(pedido.negocio_id || "")}, ${fotoUrl || ""}, ${descripcion || "Accidente en camino"}, ${reembolso})
      RETURNING *`

    await sql`INSERT INTO fondo_recuperacion (tipo, monto, descripcion, pedido_id)
      VALUES ('uso', ${reembolso}, ${"Reembolso cliente por accidente repartidor — pedido " + pedidoId}, ${String(pedidoId)})`.catch(e => logError(e, "contingencia:fondo_accidente"))

    const [updated] = await sql`UPDATE pedidos SET status = 'cancelado', cancelado_en = NOW(), razon_cancelacion = 'Cancelado por contingencia vial del repartidor' WHERE id = ${pedido.id} RETURNING *`

    if (pedido.cliente_id) {
      if (pedido.metodo_pago === "tarjeta" && reembolso > 0) {
        await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance, 0) + ${reembolso} WHERE id = ${pedido.cliente_id}`.catch(() => {})
        await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto, pedido_id) VALUES (${pedido.cliente_id}, 'credito', ${reembolso}, 'Reembolso por percance de repartidor', ${String(pedido.id)})`.catch(() => {})
      }
      notificarCliente(pedido.cliente_id, "pedido_update", updated)
      sendPushToUser(sql, pedido.cliente_id, "⚠️ Percance con tu pedido", "Tu repartidor reportó un percance en ruta. Tu pedido fue cancelado y reembolsado si pagaste con tarjeta.", { pedidoId: String(pedido.id), status: "cancelado" }).catch(() => {})
    }

    notificarContingenciaAdmin({
      titulo: "Percance / Accidente de Repartidor",
      pedidoId: String(pedidoId),
      detalle: descripcion || "El repartidor reportó un accidente o falla mecánica en camino.",
      actorTipo: "repartidor",
      actorId: String(repartidorId),
      fotoEvidenciaUrl: fotoUrl || null,
    }).catch(() => {})

    res.json({ ok: true, contingencia: rows[0] })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/contingencias/problema-restaurante — Repartidor reporta local cerrado, demora excesiva (>25 min) o negativa a entregar antes de recoger
router.post("/problema-restaurante", requireAuth, async (req, res) => {
  try {
    const authUserId = (req as any).userId
    const { pedidoId, motivo, descripcion } = req.body
    if (!pedidoId || !motivo) return res.status(400).json({ error: "pedidoId y motivo requeridos" })

    const pedidos = await sql`
      SELECT p.*, v.nombre as negocio_nombre, COALESCE(v.owner_id, v.user_id) as owner_id, v.telefono as negocio_telefono
      FROM pedidos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.id::text = ${pedidoId}
      LIMIT 1
    `
    if (!pedidos.length) return res.status(404).json({ error: "Pedido no encontrado" })
    const pedido = pedidos[0]

    if (pedido.verificado_restaurante || ["en_camino", "esperando_cliente", "entregado"].includes(pedido.status)) {
      return res.status(400).json({ error: "No puedes liberar el pedido después de haberlo recolectado en el restaurante." })
    }

    const repId = String(pedido.repartidor_id || authUserId)
    const detalleMotivo =
      motivo === "restaurante_cerrado"
        ? "Restaurante cerrado al llegar a recolectar"
        : motivo === "demora_excesiva"
          ? "Demora excesiva en cocina (>20 min esperando)"
          : (descripcion || "Problema en restaurante al recolectar")

    // Registrar en pedidos_rechazados para que no le vuelva a saltar a este mismo repartidor
    await sql`
      INSERT INTO pedidos_rechazados (pedido_id, repartidor_id)
      VALUES (${String(pedido.id)}, ${repId})
      ON CONFLICT (pedido_id, repartidor_id) DO NOTHING
    `.catch(() => {})

    if (motivo === "restaurante_cerrado") {
      // Si el local está cerrado, pausar recepción de nuevos pedidos preventivamente y cancelar el pedido reembolsando al cliente
      if (pedido.negocio_id) {
        await sql`
          UPDATE viveres
          SET aceptando_pedidos = false,
              incidentes_count = COALESCE(incidentes_count, 0) + 1
          WHERE id = ${pedido.negocio_id}
        `.catch(() => {})
      }
      const [cancelled] = await sql`
        UPDATE pedidos
        SET status = 'cancelado',
            cancelado_en = NOW(),
            repartidor_id = NULL,
            razon_cancelacion = 'Cancelado: el repartidor reportó que el restaurante se encontraba cerrado'
        WHERE id = ${pedido.id}
        RETURNING *
      `
      if (pedido.cliente_id) {
        if (pedido.metodo_pago === "tarjeta" && Number(pedido.total) > 0) {
          await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance, 0) + ${Number(pedido.total)} WHERE id = ${pedido.cliente_id}`.catch(() => {})
          await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto, pedido_id) VALUES (${pedido.cliente_id}, 'credito', ${Number(pedido.total)}, 'Reembolso: restaurante cerrado', ${String(pedido.id)})`.catch(() => {})
        }
        notificarCliente(pedido.cliente_id, "pedido_update", cancelled)
        sendPushToUser(sql, pedido.cliente_id, "😔 Restaurante cerrado", "El repartidor acudió al establecimiento pero se encontraba cerrado. Tu pedido fue cancelado sin cargo.", { pedidoId: String(pedido.id), status: "cancelado" }).catch(() => {})
      }
    } else {
      // Demora excesiva u otro motivo antes de recolectar: desasignar al repartidor sin penalización para que otro pueda tomarlo cuando esté listo
      await sql`
        UPDATE pedidos
        SET repartidor_id = NULL,
            asignado_en = NULL,
            actualizado_en = NOW()
        WHERE id = ${pedido.id}
      `
    }

    await sql`
      INSERT INTO contingencias (tipo, pedido_id, repartidor_id, cliente_id, negocio_id, descripcion)
      VALUES ('problema_restaurante', ${String(pedido.id)}, ${repId}, ${pedido.cliente_id || ""}, ${String(pedido.negocio_id || "")}, ${detalleMotivo})
    `.catch(() => {})

    notificarContingenciaAdmin({
      titulo: `Reporte en Restaurante (${pedido.negocio_nombre || "Local"})`,
      pedidoId: String(pedido.id),
      detalle: `${detalleMotivo}. El repartidor fue liberado sin penalización.`,
      actorTipo: "restaurante",
      actorId: String(pedido.negocio_id || ""),
      actorNombre: pedido.negocio_nombre || "Restaurante",
    }).catch(() => {})

    res.json({ ok: true, liberado: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.patch("/:id/resolver", requireAdmin, async (req, res) => {
  try {
    const { nota_admin } = req.body
    const rows = await sql`
      UPDATE contingencias SET status = 'resuelto', resuelto_en = NOW(), nota_admin = ${nota_admin || ""}
      WHERE id = ${req.params.id} RETURNING *`
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router

