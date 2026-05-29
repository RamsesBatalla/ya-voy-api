import { Router } from "express";
import { neon } from "@neondatabase/serverless";

const router = Router();
const sql = neon(process.env.DATABASE_URL!);

// Crear tabla si no existe
async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS reportes_soporte (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      usuario_email TEXT,
      usuario_nombre TEXT,
      pedido_id TEXT,
      tipo TEXT NOT NULL,
      comentario TEXT,
      status TEXT NOT NULL DEFAULT 'nuevo',
      creado_en TIMESTAMPTZ DEFAULT NOW(),
      resuelto_en TIMESTAMPTZ,
      nota_admin TEXT
    )
  `;
}
ensureTable().catch(console.error);

// POST /api/soporte — crear reporte
router.post("/", async (req, res) => {
  try {
    const { usuarioId, usuarioEmail, usuarioNombre, pedidoId, tipo, comentario } = req.body;
    if (!usuarioId || !tipo) return res.status(400).json({ error: "Faltan campos" });
    const [reporte] = await sql`
      INSERT INTO reportes_soporte (usuario_id, usuario_email, usuario_nombre, pedido_id, tipo, comentario)
      VALUES (${usuarioId}, ${usuarioEmail || ""}, ${usuarioNombre || ""}, ${pedidoId || null}, ${tipo}, ${comentario || ""})
      RETURNING *
    `;
    res.json(reporte);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/soporte — listar todos (dashboard)
router.get("/", async (_req, res) => {
  try {
    const reportes = await sql`SELECT * FROM reportes_soporte ORDER BY creado_en DESC LIMIT 200`;
    res.json(reportes);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/soporte/:id — actualizar status desde dashboard
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, nota_admin } = req.body;
    const [updated] = await sql`
      UPDATE reportes_soporte
      SET status = ${status}, nota_admin = ${nota_admin || ""}, resuelto_en = ${status === "resuelto" ? new Date().toISOString() : null}
      WHERE id = ${id}
      RETURNING *
    `;
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;