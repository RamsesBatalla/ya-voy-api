import { Router } from "express"
import { sql } from "../db"
import { sendPushToUser } from "../firebase"

const router = Router()

router.get("/:negocioId/pedidos", async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM pedidos WHERE negocio_id = ${req.params.negocioId}
      ORDER BY creado_en DESC LIMIT 50`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.patch("/pedidos/:id/status", async (req, res) => {
  try {
    const { status } = req.body
    const rows = await sql`
      UPDATE pedidos SET status = ${status}
      WHERE id = ${req.params.id} RETURNING *`
    const pedido = rows[0]
    if (!pedido) return res.status(404).json({ error: "Pedido no encontrado" })
    res.json(pedido)

    // Notificaciones async (no bloquean la respuesta)
    const negocio = await sql`SELECT owner_id, nombre FROM viveres WHERE id = ${pedido.negocio_id}`
    const ownerID = negocio[0]?.owner_id
    const negNombre = negocio[0]?.nombre || "el restaurante"

    if (status === "nuevo" && ownerID) {
      await sendPushToUser(sql, ownerID, "🛵 Nuevo pedido", `Tienes un pedido nuevo en ${negNombre}`, { pedidoId: pedido.id })
    }
    if (status === "preparando" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "👨‍🍳 Preparando tu pedido", `${negNombre} está preparando tu orden`, { pedidoId: pedido.id })
    }
    if (status === "en_camino" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "🛵 Tu pedido va en camino", "El repartidor está llevando tu pedido", { pedidoId: pedido.id })
    }
    if (status === "esperando_cliente" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "📍 El repartidor llegó", "Tu repartidor está esperando en la dirección indicada", { pedidoId: pedido.id })
    }
    if (status === "entregado" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "✅ Pedido entregado", "¡Que lo disfrutes! No olvides calificar tu experiencia", { pedidoId: pedido.id })
    }
    if (status === "cancelado" && pedido.cliente_id) {
      await sendPushToUser(sql, pedido.cliente_id, "❌ Pedido cancelado", "Tu pedido fue cancelado", { pedidoId: pedido.id })
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
    await sql`UPDATE pedidos SET status = ${`cancelado`}, cancelado_en = NOW() WHERE id = ${req.params.id}`
    if (cliente_id) {
      await sendPushToUser(sql, cliente_id, "Pedido cancelado", "El restaurante cancelo tu pedido", { pedidoId: req.params.id })
    }
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router