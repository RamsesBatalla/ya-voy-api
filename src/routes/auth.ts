import { Router } from "express";
import { sql } from "../db";

const router = Router();

router.post("/sync", async (req, res) => {
  try {
    const { userId, email, nombre, fotoUrl, rol } = req.body;
    await sql`
      INSERT INTO usuarios (id, email, nombre, foto_url, rol)
      VALUES (${userId}, ${email}, ${nombre}, ${fotoUrl}, ${rol || "cliente"})
      ON CONFLICT (id) DO UPDATE SET
        email    = EXCLUDED.email,
        nombre   = EXCLUDED.nombre,
        foto_url = EXCLUDED.foto_url,
        rol      = EXCLUDED.rol
    `;
    const rows = await sql`SELECT * FROM usuarios WHERE id = ${userId}`;
    res.json({ ok: true, usuario: rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/perfil/:userId", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM usuarios WHERE id = ${req.params.userId}`;
    if (!rows.length) return res.status(404).json({ error: "No encontrado" });
    res.json(rows[0]);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
