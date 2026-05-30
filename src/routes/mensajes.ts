import { Router } from "express"
import { sql } from "../db"

const router = Router()

const initTable = async () => {
  await sql`CREATE TABLE IF NOT EXISTS mensajes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id TEXT NOT NULL,
    remitente_id TEXT NOT NULL,
    remitente_tipo TEXT NOT NULL,
    texto TEXT NOT NULL,
    leido BOOLEAN DEFAULT false,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`
  await sql`CREATE INDEX IF NOT EXISTS idx_mensajes_pedido ON mensajes(pedido_id)`
}
initTable().catch(e => console.error("Error init mensajes:", e.message))

// GET /api/mensajes/:pedidoId — obtener mensajes de un pedido
router.get("/:pedidoId", async (req, res) => {
  try {
    // Solo permitir chat en pedidos activos
    const pedidos = await sql`SELECT status FROM pedidos WHERE id = ${req.params.pedidoId}`
    if (!pedidos.length) return res.status(404).json({ error: "Pedido no encontrado" })
    const rows = await sql`
      SELECT * FROM mensajes WHERE pedido_id = ${req.params.pedidoId}
      ORDER BY creado_en ASC LIMIT 100`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/mensajes — enviar mensaje
// body: { pedidoId, remitenteId, remitenteTipo: "usuario"|"repartidor", texto }
router.post("/", async (req, res) => {
  try {
    const { pedidoId, remitenteId, remitenteTipo, texto } = req.body
    if (!pedidoId || !remitenteId || !remitenteTipo || !texto?.trim())
      return res.status(400).json({ error: "Campos requeridos" })

    // Solo en pedidos en_camino o esperando_cliente
    const pedidos = await sql`SELECT status FROM pedidos WHERE id = ${pedidoId}`
    if (!pedidos.length) return res.status(404).json({ error: "Pedido no encontrado" })
    const { status } = pedidos[0]
    if (!["en_camino", "esperando_cliente"].includes(status))
      return res.status(400).json({ error: "Chat solo disponible cuando el pedido esta en camino" })

    const rows = await sql`
      INSERT INTO mensajes (pedido_id, remitente_id, remitente_tipo, texto)
      VALUES (${pedidoId}, ${remitenteId}, ${remitenteTipo}, ${texto.trim()})
      RETURNING *`
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PATCH /api/mensajes/:pedidoId/leidos — marcar como leídos
router.patch("/:pedidoId/leidos", async (req, res) => {
  try {
    const { lectorTipo } = req.body // "usuario" o "repartidor" — marca como leídos los del otro
    const otroTipo = lectorTipo === "usuario" ? "repartidor" : "usuario"
    await sql`UPDATE mensajes SET leido = true WHERE pedido_id = ${req.params.pedidoId} AND remitente_tipo = ${otroTipo}`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
