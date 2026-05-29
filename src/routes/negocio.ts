import { Router } from "express";
import { sql } from "../db";

const router = Router();

router.patch("/:id/imagen", async (req, res) => {
  try {
    const { imagen_url } = req.body;
    const rows = await sql`UPDATE viveres SET imagen_url = ${imagen_url} WHERE id = ${req.params.id} RETURNING *`;
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/:id/toggle", async (req, res) => {
  try {
    const rows = await sql`
      UPDATE viveres SET esta_abierto = NOT esta_abierto
      WHERE id = ${req.params.id} RETURNING *
    `;
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/:id/perfil", async (req, res) => {
  try {
    const { nombre, direccion, telefono, descripcion } = req.body;
    const rows = await sql`
      UPDATE viveres SET
        nombre = COALESCE(${nombre}, nombre),
        direccion = COALESCE(${direccion}, direccion),
        telefono = COALESCE(${telefono}, telefono),
        descripcion = COALESCE(${descripcion}, descripcion)
      WHERE id = ${req.params.id} RETURNING *
    `;
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/:id/horarios", async (req, res) => {
  try {
    const { horarios } = req.body;
    // Agregar columna si no existe
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS horarios JSONB`;
    const rows = await sql`
      UPDATE viveres SET horarios = ${JSON.stringify(horarios)}::jsonb
      WHERE id = ${req.params.id} RETURNING *
    `;
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
