import { Router } from "express"
import { sql } from "../db"

const router = Router()

// Crear tablas si no existen
const initTables = async () => {
  await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado BOOLEAN DEFAULT false`
  await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS razon_bloqueo TEXT`
  await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_en TIMESTAMPTZ`
  await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS bloqueado BOOLEAN DEFAULT false`
  await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS razon_bloqueo TEXT`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS bloqueado BOOLEAN DEFAULT false`
  await sql`CREATE TABLE IF NOT EXISTS bloqueos_historial (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo_usuario TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    razon TEXT,
    bloqueado_por TEXT DEFAULT 'admin',
    fecha TIMESTAMPTZ DEFAULT NOW(),
    desbloqueado_en TIMESTAMPTZ,
    resuelto BOOLEAN DEFAULT false,
    nota_desbloqueo TEXT
  )`
}
initTables().catch(e => console.error("Error init bloqueos:", e.message))

// GET /api/bloqueos — lista todos los bloqueados
router.get("/", async (_req, res) => {
  try {
    const [usuarios, repartidores, negocios] = await Promise.all([
      sql`SELECT id, email, nombre, razon_bloqueo, bloqueado_en FROM usuarios WHERE bloqueado = true`,
      sql`SELECT r.id, r.razon_bloqueo, u.email, u.nombre FROM repartidores r LEFT JOIN usuarios u ON u.id = r.id WHERE r.bloqueado = true`,
      sql`SELECT id, nombre, direccion, razon_bloqueo FROM viveres WHERE bloqueado = true`,
    ])
    res.json({ usuarios, repartidores, negocios })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /api/bloqueos/historial
router.get("/historial", async (_req, res) => {
  try {
    const rows = await sql`SELECT * FROM bloqueos_historial ORDER BY fecha DESC LIMIT 200`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/bloqueos — bloquear
// body: { tipo: "usuario"|"repartidor"|"negocio", actorId, razon }
router.post("/", async (req, res) => {
  try {
    const { tipo, actorId, razon } = req.body
    if (!tipo || !actorId) return res.status(400).json({ error: "tipo y actorId requeridos" })

    if (tipo === "usuario") {
      await sql`UPDATE usuarios SET bloqueado = true, razon_bloqueo = ${razon || ""}, bloqueado_en = NOW() WHERE id = ${actorId}`
    } else if (tipo === "repartidor") {
      await sql`UPDATE repartidores SET bloqueado = true, razon_bloqueo = ${razon || ""} WHERE id = ${actorId}`
    } else if (tipo === "negocio") {
      await sql`UPDATE viveres SET bloqueado = true, razon_bloqueo = ${razon || ""} WHERE id = ${actorId}`
    } else {
      return res.status(400).json({ error: "tipo invalido" })
    }

    await sql`INSERT INTO bloqueos_historial (tipo_usuario, actor_id, razon) VALUES (${tipo}, ${actorId}, ${razon || ""})`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/bloqueos — desbloquear
// body: { tipo, actorId, nota }
router.delete("/", async (req, res) => {
  try {
    const { tipo, actorId, nota } = req.body
    if (!tipo || !actorId) return res.status(400).json({ error: "tipo y actorId requeridos" })

    if (tipo === "usuario") {
      await sql`UPDATE usuarios SET bloqueado = false, razon_bloqueo = NULL, bloqueado_en = NULL WHERE id = ${actorId}`
    } else if (tipo === "repartidor") {
      await sql`UPDATE repartidores SET bloqueado = false, razon_bloqueo = NULL WHERE id = ${actorId}`
    } else if (tipo === "negocio") {
      await sql`UPDATE viveres SET bloqueado = false, razon_bloqueo = NULL WHERE id = ${actorId}`
    }

    await sql`UPDATE bloqueos_historial SET resuelto = true, desbloqueado_en = NOW(), nota_desbloqueo = ${nota || ""}
      WHERE actor_id = ${actorId} AND tipo_usuario = ${tipo} AND resuelto = false`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
