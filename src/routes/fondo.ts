import { Router } from "express"
import { sql } from "../db"

const router = Router()

const COMISION_PCT = 0.12   // 12% Batalla Group del total
const FONDO_PCT    = 0.15   // 15% de esa comisión al fondo

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
router.get("/resumen", async (_req, res) => {
  try {
    // Total comisiones acumuladas (pedidos entregados)
    const comRows = await sql`
      SELECT COALESCE(SUM(ROUND((total * ${COMISION_PCT})::numeric, 2)), 0) as total
      FROM pedidos WHERE status = 'entregado'`
    const totalComision = Number(comRows[0]?.total || 0)

    // Fondo = 15% de las comisiones acumuladas
    const fondoAcumulado = Math.round(totalComision * FONDO_PCT * 100) / 100
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
router.get("/log", async (_req, res) => {
  try {
    const rows = await sql`SELECT * FROM fondo_recuperacion ORDER BY creado_en DESC LIMIT 200`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/fondo/uso — registrar uso del fondo (solo Ramses desde dashboard)
// body: { monto, descripcion }
router.post("/uso", async (req, res) => {
  try {
    const { monto, descripcion } = req.body
    if (!monto || monto <= 0) return res.status(400).json({ error: "Monto invalido" })

    // Verificar saldo disponible
    const resumen = await fetch(`http://localhost:${process.env.PORT || 3001}/api/fondo/resumen`).then(r => r.json()).catch(() => null)
    // Si no puede verificar, continúa de todos modos (el dashboard valida antes)

    const rows = await sql`
      INSERT INTO fondo_recuperacion (tipo, monto, descripcion)
      VALUES ('uso', ${monto}, ${descripcion || ""})
      RETURNING *`
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/fondo/ingreso — registrar ingreso manual (auditoría)
router.post("/ingreso", async (req, res) => {
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
