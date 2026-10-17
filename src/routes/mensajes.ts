import { Router } from "express"
import { sql } from "../db"
import { requireAuth } from "../middleware/auth"
import { sendPushToUser } from "../firebase"
import { notificarCliente } from "../websocket"

const router = Router()

const initTable = async () => {
  await sql`CREATE TABLE IF NOT EXISTS mensajes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id TEXT NOT NULL,
    emisor_id TEXT NOT NULL,
    rol_emisor TEXT NOT NULL,
    mensaje TEXT NOT NULL,
    leido BOOLEAN DEFAULT false,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`
  await sql`CREATE INDEX IF NOT EXISTS idx_mensajes_pedido ON mensajes(pedido_id)`
}
initTable().catch(e => console.error("Error init mensajes:", e.message))

// GET /api/mensajes/:pedidoId — obtener mensajes de un pedido
router.get("/:pedidoId", requireAuth, async (req, res) => {
  try {
    const pedidos = await sql`SELECT status FROM pedidos WHERE id::text = ${req.params.pedidoId}`
    if (!pedidos.length) return res.status(404).json({ error: "Pedido no encontrado" })
    const rows = await sql`
      SELECT id, pedido_id, emisor_id as remitente_id, rol_emisor as remitente_tipo, mensaje as texto, leido, creado_en
      FROM mensajes WHERE pedido_id = ${req.params.pedidoId}
      ORDER BY creado_en ASC LIMIT 100`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/mensajes — enviar mensaje en tiempo real (WebSocket + Push)
// body: { pedidoId, remitenteId, remitenteTipo: "cliente"|"repartidor", texto }
router.post("/", requireAuth, async (req, res) => {
  try {
    const { pedidoId, remitenteId, remitenteTipo, texto } = req.body
    if (!pedidoId || !remitenteId || !remitenteTipo || !texto?.trim())
      return res.status(400).json({ error: "Campos requeridos" })

    const pedidos = await sql`SELECT status FROM pedidos WHERE id::text = ${pedidoId}`
    if (!pedidos.length) return res.status(404).json({ error: "Pedido no encontrado" })
    const { status } = pedidos[0]
    if (!["preparando", "listo", "en_camino", "esperando_cliente"].includes(status))
      return res.status(400).json({ error: "El chat solo está disponible mientras tu pedido está activo" })

    const rows = await sql`
      INSERT INTO mensajes (pedido_id, emisor_id, rol_emisor, mensaje)
      VALUES (${String(pedidoId)}, ${remitenteId}, ${remitenteTipo}, ${texto.trim()})
      RETURNING id, pedido_id, emisor_id as remitente_id, rol_emisor as remitente_tipo, mensaje as texto, leido, creado_en`

    const msgPayload = {
      pedidoId: String(pedidoId),
      mensaje: rows[0],
    }

    // Notificar en tiempo real (WebSocket + Push) a los destinatarios
    const pedidoRows = await sql`
      SELECT p.cliente_id, p.repartidor_id, COALESCE(v.owner_id, v.user_id) as owner_id
      FROM pedidos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.id::text = ${pedidoId}`
    if (pedidoRows.length) {
      const { cliente_id, repartidor_id, owner_id } = pedidoRows[0]
      const notifTitle = remitenteTipo === "repartidor" ? "🛵 Mensaje de tu repartidor" : "💬 Mensaje del cliente"
      const notifBody = texto.trim().length > 60 ? texto.trim().slice(0, 57) + "..." : texto.trim()
      const data = { pedidoId: String(pedidoId), tipo: "chat" }
      if (remitenteTipo !== "cliente" && cliente_id) {
        notificarCliente(cliente_id, "nuevo_mensaje", msgPayload)
        sendPushToUser(sql, cliente_id, notifTitle, notifBody, data).catch(() => {})
      }
      if (remitenteTipo !== "repartidor" && repartidor_id) {
        notificarCliente(repartidor_id, "nuevo_mensaje", msgPayload)
        sendPushToUser(sql, repartidor_id, notifTitle, notifBody, data).catch(() => {})
      }
      if (remitenteTipo !== "restaurante" && owner_id) {
        notificarCliente(owner_id, "nuevo_mensaje", msgPayload)
      }
    }

    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PATCH /api/mensajes/:pedidoId/leidos — marcar como leídos
router.patch("/:pedidoId/leidos", requireAuth, async (req, res) => {
  try {
    const { lectorTipo } = req.body // "cliente" o "repartidor" — marca como leídos los del otro
    const otroTipo = lectorTipo === "cliente" ? "repartidor" : "cliente"
    await sql`UPDATE mensajes SET leido = true WHERE pedido_id = ${req.params.pedidoId} AND rol_emisor = ${otroTipo}`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router

