import { Router } from "express"
import { sql } from "../db"

const router = Router()

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
    nota_admin TEXT,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`
  await sql`ALTER TABLE retiros ADD COLUMN IF NOT EXISTS creado_en TIMESTAMPTZ DEFAULT NOW()`
}
initTable().catch(e => console.error("Error init retiros:", e.message))

// GET /api/retiros — todos (dashboard)
router.get("/", async (_req, res) => {
  try {
    const rows = await sql`SELECT * FROM retiros ORDER BY fecha_solicitud DESC LIMIT 200`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /api/retiros/:tipo/:actorId — retiros de un actor
router.get("/:tipo/:actorId", async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM retiros
      WHERE tipo_actor = ${req.params.tipo} AND actor_id = ${req.params.actorId}
      ORDER BY fecha_solicitud DESC LIMIT 50`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /api/retiros/saldo/:tipo/:actorId — saldo disponible
router.get("/saldo/:tipo/:actorId", async (req, res) => {
  try {
    const { tipo, actorId } = req.params
    const cfg = await sql`SELECT clave, valor FROM app_config WHERE clave IN ('comision_pct','envio_minimo')`
    const cfgMap: Record<string,number> = {}
    cfg.forEach((r: any) => { cfgMap[r.clave] = parseFloat(r.valor) })
    const comisionPct = (cfgMap.comision_pct ?? 18) / 100
    let ganado = 0

    if (tipo === "repartidor") {
      const rows = await sql`
        SELECT COALESCE(SUM(COALESCE(costo_envio, 35)), 0) as total
        FROM pedidos WHERE repartidor_id = ${actorId} AND status = 'entregado'`
      ganado = Number(rows[0]?.total || 0)
    } else if (tipo === "restaurante") {
      const negocio = await sql`SELECT id FROM viveres WHERE owner_id = ${actorId}`
      if (negocio.length) {
        const rows = await sql`
          SELECT COALESCE(SUM((total - COALESCE(costo_envio,35)) * ${1 - comisionPct}), 0) as total
          FROM pedidos WHERE negocio_id = ${negocio[0].id} AND status = 'entregado'`
        ganado = Number(rows[0]?.total || 0)
      }
    }

    const retiradoRows = await sql`
      SELECT COALESCE(SUM(monto), 0) as total FROM retiros
      WHERE tipo_actor = ${tipo} AND actor_id = ${actorId} AND status != 'rechazado'`
    const retirado = Number(retiradoRows[0]?.total || 0)

    res.json({ ganado, retirado, disponible: Math.max(0, ganado - retirado) })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/retiros — solicitar retiro
router.post("/", async (req, res) => {
  try {
    const { tipo_actor, actor_id, actor_nombre, monto } = req.body
    if (!tipo_actor || !actor_id || !monto || monto <= 0)
      return res.status(400).json({ error: "Datos invalidos" })

    const cfg = await sql`SELECT valor FROM app_config WHERE clave = 'retiro_minimo'`
    const minimo = Number(cfg[0]?.valor || 50)
    if (monto < minimo)
      return res.status(400).json({ error: "Monto menor al minimo permitido ($" + minimo + " MXN)" })

    const pendiente = await sql`
      SELECT id FROM retiros
      WHERE tipo_actor = ${tipo_actor} AND actor_id = ${actor_id} AND status = 'pendiente'`
    if (pendiente.length > 0)
      return res.status(409).json({ error: "Ya tienes un retiro pendiente de aprobacion" })

    const rows = await sql`
      INSERT INTO retiros (tipo_actor, actor_id, actor_nombre, monto)
      VALUES (${tipo_actor}, ${actor_id}, ${actor_nombre || ""}, ${monto})
      RETURNING *`
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PATCH /api/retiros/:id — aprobar/rechazar (dashboard)
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