import { Router } from "express"
import { sql } from "../db"

const router = Router()

// Crear tabla si no existe
const initTable = async () => {
  await sql`CREATE TABLE IF NOT EXISTS retiros (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo_actor TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_nombre TEXT,
    monto NUMERIC NOT NULL,
    status TEXT DEFAULT 'pendiente',
    fecha_solicitud TIMESTAMPTZ DEFAULT NOW(),
    fecha_pago TIMESTAMPTZ,
    nota_admin TEXT
  )`
}
initTable().catch(e => console.error("Error init retiros:", e.message))

// GET /api/retiros — todos los retiros (para dashboard)
router.get("/", async (_req, res) => {
  try {
    const rows = await sql`SELECT * FROM retiros ORDER BY fecha_solicitud DESC LIMIT 200`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /api/retiros/:tipo/:actorId — retiros de un actor específico
router.get("/:tipo/:actorId", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM retiros WHERE tipo_actor = ${req.params.tipo} AND actor_id = ${req.params.actorId} ORDER BY fecha_solicitud DESC LIMIT 50`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /api/retiros/saldo/:tipo/:actorId — saldo disponible (ganancias - retiros pagados)
router.get("/saldo/:tipo/:actorId", async (req, res) => {
  try {
    const { tipo, actorId } = req.params
    let ganado = 0

    if (tipo === "repartidor") {
      const rows = await sql`
        SELECT COALESCE(SUM(ROUND((total * 0.15)::numeric, 2)), 0) as total
        FROM pedidos WHERE repartidor_id = ${actorId} AND status = 'entregado'`
      ganado = Number(rows[0]?.total || 0)
    } else if (tipo === "restaurante") {
      const negocio = await sql`SELECT id FROM viveres WHERE owner_id = ${actorId}`
      if (negocio.length) {
        const rows = await sql`
          SELECT COALESCE(SUM(ROUND((total * 0.73)::numeric, 2)), 0) as total
          FROM pedidos WHERE negocio_id = ${negocio[0].id} AND status = 'entregado'`
        ganado = Number(rows[0]?.total || 0)
      }
    }

    const retiradoRows = await sql`
      SELECT COALESCE(SUM(monto), 0) as total FROM retiros
      WHERE tipo_actor = ${tipo} AND actor_id = ${actorId} AND status = 'pagado'`
    const retirado = Number(retiradoRows[0]?.total || 0)

    res.json({ ganado, retirado, disponible: Math.max(0, ganado - retirado) })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/retiros — solicitar retiro
// body: { tipo_actor, actor_id, actor_nombre, monto }
router.post("/", async (req, res) => {
  try {
    const { tipo_actor, actor_id, actor_nombre, monto } = req.body
    if (!tipo_actor || !actor_id || !monto || monto <= 0)
      return res.status(400).json({ error: "Datos invalidos" })

    // Verificar que no haya retiro pendiente
    const pendiente = await sql`SELECT id FROM retiros WHERE tipo_actor = ${tipo_actor} AND actor_id = ${actor_id} AND status = 'pendiente'`
    if (pendiente.length > 0)
      return res.status(409).json({ error: "Ya tienes un retiro pendiente de aprobacion" })

    const rows = await sql`
      INSERT INTO retiros (tipo_actor, actor_id, actor_nombre, monto)
      VALUES (${tipo_actor}, ${actor_id}, ${actor_nombre || ""}, ${monto})
      RETURNING *`
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PATCH /api/retiros/:id — aprobar/rechazar (solo dashboard)
// body: { status: "aprobado"|"pagado"|"rechazado", nota_admin }
router.patch("/:id", async (req, res) => {
  try {
    const { status, nota_admin } = req.body
    const fechaPago = status === "pagado" ? new Date().toISOString() : null
    const rows = await sql`
      UPDATE retiros SET status = ${status}, nota_admin = ${nota_admin || ""},
        fecha_pago = ${fechaPago}
      WHERE id = ${req.params.id} RETURNING *`
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
