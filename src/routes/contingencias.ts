import { Router } from "express"
import { sql } from "../db"

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

router.get("/", async (_req, res) => {
  try {
    const rows = await sql`SELECT * FROM contingencias ORDER BY creado_en DESC LIMIT 200`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post("/no-pago", async (req, res) => {
  try {
    const { pedidoId, repartidorId, descripcion } = req.body
    if (!pedidoId || !repartidorId) return res.status(400).json({ error: "pedidoId y repartidorId requeridos" })

    const pedidos = await sql`SELECT * FROM pedidos WHERE id = ${pedidoId}`
    if (!pedidos.length) return res.status(404).json({ error: "Pedido no encontrado" })
    const pedido = pedidos[0]

    // Validar ventana de 24h
    if (pedido.entregado_en) {
      const diffHrs = (Date.now() - new Date(pedido.entregado_en).getTime()) / 1000 / 3600
      if (diffHrs > 24) return res.status(400).json({ error: "El plazo de reporte de 24 horas ha vencido para este pedido" })
    }

    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado BOOLEAN DEFAULT false`
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS razon_bloqueo TEXT`
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_en TIMESTAMPTZ`
    if (pedido.cliente_id) {
      await sql`UPDATE usuarios SET bloqueado = true, razon_bloqueo = 'No pago en efectivo — reporte de repartidor', bloqueado_en = NOW() WHERE id = ${pedido.cliente_id}`
      await sql`INSERT INTO bloqueos_historial (tipo_usuario, actor_id, razon) VALUES ('usuario', ${pedido.cliente_id}, 'No pago en efectivo — reporte de repartidor')`.catch(() => {})
    }

    const envio = 35
    const rows = await sql`
      INSERT INTO contingencias (tipo, pedido_id, repartidor_id, cliente_id, negocio_id, descripcion, monto_fondo)
      VALUES ('no_pago', ${pedidoId}, ${repartidorId}, ${pedido.cliente_id || ""}, ${pedido.negocio_id || ""}, ${descripcion || "Cliente se nego a pagar en efectivo"}, ${envio})
      RETURNING *`

    await sql`INSERT INTO fondo_recuperacion (tipo, monto, descripcion, pedido_id)
      VALUES ('uso', ${envio}, ${"Pago envio repartidor por no-pago cliente — pedido " + pedidoId}, ${pedidoId})`.catch(() => {})

    res.json({ ok: true, contingencia: rows[0] })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post("/accidente", async (req, res) => {
  try {
    const { pedidoId, repartidorId, fotoUrl, descripcion } = req.body
    if (!pedidoId || !repartidorId) return res.status(400).json({ error: "pedidoId y repartidorId requeridos" })

    const pedidos = await sql`SELECT * FROM pedidos WHERE id = ${pedidoId}`
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
      VALUES ('accidente', ${pedidoId}, ${repartidorId}, ${pedido.cliente_id || ""}, ${pedido.negocio_id || ""}, ${fotoUrl || ""}, ${descripcion || "Accidente en camino"}, ${reembolso})
      RETURNING *`

    await sql`INSERT INTO fondo_recuperacion (tipo, monto, descripcion, pedido_id)
      VALUES ('uso', ${reembolso}, ${"Reembolso cliente por accidente repartidor — pedido " + pedidoId}, ${pedidoId})`.catch(() => {})

    await sql`UPDATE pedidos SET status = 'cancelado', cancelado_en = NOW() WHERE id = ${pedidoId}`

    res.json({ ok: true, contingencia: rows[0] })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.patch("/:id/resolver", async (req, res) => {
  try {
    const { nota_admin } = req.body
    const rows = await sql`
      UPDATE contingencias SET status = 'resuelto', resuelto_en = NOW(), nota_admin = ${nota_admin || ""}
      WHERE id = ${req.params.id} RETURNING *`
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router