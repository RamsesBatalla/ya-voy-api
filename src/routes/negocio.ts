import { Router } from "express";
import { sql } from "../db";
import { requireAuth } from "../middleware/auth";
import { invalidateCache } from "../cache";

const router = Router();

router.patch("/:id/imagen",  requireAuth, async (req, res) => {
  try {
    const { imagen_url } = req.body;
    const rows = await sql`UPDATE viveres SET imagen_url = ${imagen_url} WHERE id = ${req.params.id} RETURNING *`;
    invalidateCache("negocios:all")
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/:id/toggle",  requireAuth, async (req, res) => {
  try {
    const rows = await sql`UPDATE viveres SET esta_abierto = NOT esta_abierto WHERE id = ${req.params.id} RETURNING *`;
    invalidateCache("negocios:all")
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/:id/pausar", requireAuth, async (req, res) => {
  try {
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS aceptando_pedidos BOOLEAN NOT NULL DEFAULT true`;
    const rows = await sql`UPDATE viveres SET aceptando_pedidos = NOT aceptando_pedidos WHERE id = ${req.params.id} RETURNING *`;
    invalidateCache("negocios:all")
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/:id/perfil",  requireAuth, async (req, res) => {
  try {
    const { nombre, direccion, telefono, descripcion, tipo, categoria } = req.body;
    const cleanTipo = tipo ? (tipo.toLowerCase().includes('tienda') ? 'tienda' : 'restaurante') : null;
    const rows = await sql`
      UPDATE viveres SET
        nombre      = COALESCE(${nombre},      nombre),
        direccion   = COALESCE(${direccion},   direccion),
        telefono    = COALESCE(${telefono},    telefono),
        descripcion = COALESCE(${descripcion}, descripcion),
        tipo        = COALESCE(${cleanTipo},   tipo),
        categoria   = COALESCE(${categoria},   categoria)
      WHERE id = ${req.params.id} RETURNING *
    `;
    invalidateCache("negocios:all");
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/:id/calificaciones-aspectos", async (req, res) => {
  try {
    const [neg] = await sql`SELECT id, rating FROM viveres WHERE id = ${req.params.id} OR owner_id = ${req.params.id} LIMIT 1`;
    const targetNegId = neg?.id || req.params.id;
    const pedidosRows = await sql`
      SELECT rating_restaurante, aspectos_restaurante 
      FROM pedidos 
      WHERE negocio_id = ${targetNegId} AND rating_restaurante IS NOT NULL
      ORDER BY creado_en DESC LIMIT 100
    `;
    const ratingPromedio = neg?.rating ? Number(Number(neg.rating).toFixed(1)) : 5.0;
    const aspectosConteo: Record<string, number> = {
      "Sabor": 0,
      "Empaque": 0,
      "Puntualidad": 0,
      "Presentación": 0,
      "Temperatura": 0
    };
    let totalRatings = pedidosRows.length;
    for (const p of pedidosRows) {
      const asp = Array.isArray(p.aspectos_restaurante) ? p.aspectos_restaurante : (typeof p.aspectos_restaurante === 'string' ? JSON.parse(p.aspectos_restaurante) : []);
      for (const a of asp) {
        if (aspectosConteo[a] !== undefined) aspectosConteo[a]++;
        else aspectosConteo[a] = 1;
      }
    }
    res.json({
      rating: ratingPromedio,
      total: totalRatings,
      aspectos: aspectosConteo
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/:id/horarios", requireAuth, async (req, res) => {
  try {
    const { horarios } = req.body;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS horarios JSONB`;
    const rows = await sql`UPDATE viveres SET horarios = ${JSON.stringify(horarios)}::jsonb WHERE id = ${req.params.id} RETURNING *`;
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/:id/cupones", requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM cupones WHERE negocio_id = ${req.params.id} ORDER BY creado_en DESC`;
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/:id/cupones", requireAuth, async (req, res) => {
  try {
    const { codigo, tipo, valor, usos_max, expira_en, minimo_compra, nombre, descripcion } = req.body;
    if (!codigo || !tipo || !valor) return res.status(400).json({ error: "codigo, tipo y valor requeridos" });
    const existe = await sql`SELECT id FROM cupones WHERE codigo = ${codigo.toUpperCase().trim()}`;
    if (existe.length) return res.status(409).json({ error: "Ya existe un cupon con ese codigo" });
    const rows = await sql`
      INSERT INTO cupones (codigo, tipo, valor, usos_max, expira_en, minimo_compra, nombre, descripcion, negocio_id)
      VALUES (${codigo.toUpperCase().trim()}, ${tipo}, ${valor}, ${usos_max || 100}, ${expira_en || null}, ${minimo_compra || 0}, ${nombre || null}, ${descripcion || null}, ${req.params.id})
      RETURNING *`;
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/:id/cupones/:cuponId", requireAuth, async (req, res) => {
  try {
    const { activo } = req.body;
    const rows = await sql`UPDATE cupones SET activo = ${activo} WHERE id = ${req.params.cuponId} AND negocio_id = ${req.params.id} RETURNING *`;
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/:id/cupones/:cuponId", requireAuth, async (req, res) => {
  try {
    await sql`DELETE FROM cupones WHERE id = ${req.params.cuponId} AND negocio_id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
