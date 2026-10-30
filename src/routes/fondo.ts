import { Router } from "express"
import { sql } from "../db"
import { requireAdmin } from "../middleware/auth"

const router = Router()

const getConfig = async () => {
  const rows = await sql`SELECT clave, valor FROM app_config WHERE clave IN ('comision_pct','fondo_pct')`
  const cfg: Record<string,number> = {}
  rows.forEach((r: any) => { cfg[r.clave] = parseFloat(r.valor) })
  return {
    comisionPct: (cfg.comision_pct ?? 18) / 100,
    fondoPct:    (cfg.fondo_pct    ?? 20) / 100,
  }
}

// Crear tablas si no existen
const initTables = async () => {
  await sql`CREATE TABLE IF NOT EXISTS fondo_recuperacion (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo TEXT NOT NULL,
    monto NUMERIC NOT NULL,
    descripcion TEXT,
    pedido_id TEXT,
    aprobado_por TEXT DEFAULT 'admin',
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`
}
initTables().catch(e => console.error("Error init fondo:", e.message))

// GET /api/fondo/resumen — saldo neto + fondo
router.get("/resumen", requireAdmin, async (_req, res) => {
  try {
    const cfg = await getConfig()
    // Total comisiones acumuladas (pedidos entregados, sobre el subtotal de comida sin envío ni propina)
    const comRows = await sql`
      SELECT COALESCE(SUM(ROUND((GREATEST(0, COALESCE(total, 0) - COALESCE(costo_envio, 0) - COALESCE(propina, 0)) * ${cfg.comisionPct})::numeric, 2)), 0) as total
      FROM pedidos WHERE status = 'entregado'`
    const totalComision = Number(comRows[0]?.total || 0)

    // Fondo = fondo_pct% de las comisiones acumuladas
    const fondoAcumulado = Math.round(totalComision * cfg.fondoPct * 100) / 100
    // Ganancias netas = comision - fondo
    const gananciasNetas = Math.round((totalComision - fondoAcumulado) * 100) / 100

    // Usos del fondo (salidas)
    const usosRows = await sql`
      SELECT COALESCE(SUM(monto), 0) as total FROM fondo_recuperacion WHERE tipo = 'uso'`
    const fondoUsado = Number(usosRows[0]?.total || 0)
    const fondoDisponible = Math.max(0, fondoAcumulado - fondoUsado)

    res.json({ totalComision, fondoAcumulado, fondoUsado, fondoDisponible, gananciasNetas })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /api/fondo/log — historial de movimientos
router.get("/log", requireAdmin, async (_req, res) => {
  try {
    const rows = await sql`SELECT * FROM fondo_recuperacion ORDER BY creado_en DESC LIMIT 200`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/fondo/uso — registrar uso del fondo (solo admin)
// body: { monto, descripcion }
router.post("/uso", requireAdmin, async (req, res) => {
  try {
    const { monto, descripcion } = req.body
    if (!monto || monto <= 0) return res.status(400).json({ error: "Monto invalido" })
    // Verificar saldo disponible antes de registrar
    const cfg = await getConfig()
    const comRows = await sql`
      SELECT COALESCE(SUM(ROUND((GREATEST(0, COALESCE(total, 0) - COALESCE(costo_envio, 0) - COALESCE(propina, 0)) * ${cfg.comisionPct})::numeric, 2)), 0) as total
      FROM pedidos WHERE status = 'entregado'
    `
    const totalComision = Number(comRows[0]?.total || 0)
    const fondoAcumulado = Math.round(totalComision * cfg.fondoPct * 100) / 100
    const usosRows = await sql`SELECT COALESCE(SUM(monto), 0) as total FROM fondo_recuperacion WHERE tipo = 'uso'`
    const fondoUsado = Number(usosRows[0]?.total || 0)
    const fondoDisponible = Math.max(0, fondoAcumulado - fondoUsado)
    if (monto > fondoDisponible) return res.status(400).json({ error: "Saldo insuficiente en el fondo", fondoDisponible })
    const rows = await sql`
      INSERT INTO fondo_recuperacion (tipo, monto, descripcion)
      VALUES ('uso', ${monto}, ${descripcion || ""})
      RETURNING *`
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/fondo/ingreso — registrar ingreso manual (auditoría)
router.post("/ingreso", requireAdmin, async (req, res) => {
  try {
    const { monto, descripcion, pedidoId } = req.body
    const rows = await sql`
      INSERT INTO fondo_recuperacion (tipo, monto, descripcion, pedido_id)
      VALUES ('ingreso', ${monto}, ${descripcion || ""}, ${pedidoId || null})
      RETURNING *`
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
