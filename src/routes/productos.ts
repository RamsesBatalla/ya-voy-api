import { Router } from 'express';
import { sql } from '../db';
import { requireAuth, ADMIN_IDS } from '../middleware/auth';

const router = Router();

import { logError } from "../logger";
import { invalidateCache } from "../cache";

sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS opciones JSONB DEFAULT '[]'`.catch(e => logError(e, "productos:init"));

router.get('/:negocioId/productos', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM productos WHERE negocio_id = ${req.params.negocioId} ORDER BY categoria, nombre`;
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

function sanitizarOpciones(raw: any) {
  if (!raw || !Array.isArray(raw)) return []
  return raw
    .map((g: any) => {
      const nombreGrupo = String(g.nombre || "").trim()
      const opcionesValidas = Array.isArray(g.opciones)
        ? g.opciones
            .map((o: any) => ({
              nombre: String(o.nombre || "").trim(),
              precio: Math.max(0, Number(o.precio) || 0),
            }))
            .filter((o: any) => o.nombre.length > 0)
        : []
      return {
        ...g,
        nombre: nombreGrupo,
        opciones: opcionesValidas,
      }
    })
    .filter((g: any) => g.nombre.length > 0 && g.opciones.length > 0)
}

router.post('/productos', requireAuth, async (req, res) => {
  try {
    const { negocio_id, nombre, descripcion, precio, categoria, disponible, destacado, imagen_url, opciones } = req.body;
    const cleanOpciones = sanitizarOpciones(opciones);
    const rows = await sql`
      INSERT INTO productos (negocio_id, nombre, descripcion, precio, categoria, disponible, destacado, imagen_url, opciones)
      VALUES (${negocio_id}, ${nombre}, ${descripcion || ''}, ${precio}, ${categoria}, ${disponible ?? true}, ${destacado ?? false}, ${imagen_url || ''}, ${JSON.stringify(cleanOpciones)}::jsonb)
      RETURNING *`;
    invalidateCache("productos:" + negocio_id)
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put('/productos/:id', requireAuth, async (req, res) => {
  try {
    const uid = (req as any).userId;
    const check = await sql`
      SELECT p.id, p.negocio_id, COALESCE(v.owner_id, v.user_id) as owner_id
      FROM productos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.id = ${req.params.id}
      LIMIT 1
    `;
    if (!check.length) return res.status(404).json({ error: "Producto no encontrado" });
    if (check[0].owner_id && check[0].owner_id !== uid && !ADMIN_IDS.includes(uid)) {
      return res.status(403).json({ error: "No tienes permiso para modificar este producto" });
    }

    const { nombre, descripcion, precio, categoria, disponible, destacado, imagen_url, opciones } = req.body;
    const cleanOpciones = sanitizarOpciones(opciones);
    const rows = await sql`
      UPDATE productos SET nombre=${nombre}, descripcion=${descripcion}, precio=${precio},
      categoria=${categoria}, disponible=${disponible}, destacado=${destacado}, imagen_url=${imagen_url || ''},
      opciones=${JSON.stringify(cleanOpciones)}::jsonb
      WHERE id=${req.params.id} RETURNING *`;
    if (rows[0]?.negocio_id) invalidateCache("productos:" + rows[0].negocio_id)
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch('/productos/:id/agotado', requireAuth, async (req, res) => {
  try {
    const uid = (req as any).userId;
    const check = await sql`
      SELECT p.id, p.negocio_id, COALESCE(v.owner_id, v.user_id) as owner_id
      FROM productos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.id = ${req.params.id}
      LIMIT 1
    `;
    if (!check.length) return res.status(404).json({ error: "Producto no encontrado" });
    if (check[0].owner_id && check[0].owner_id !== uid && !ADMIN_IDS.includes(uid)) {
      return res.status(403).json({ error: "No tienes permiso para modificar este producto" });
    }

    const rows = await sql`UPDATE productos SET agotado = NOT agotado WHERE id = ${req.params.id} RETURNING negocio_id, agotado`
    if (rows[0]?.negocio_id) invalidateCache("productos:" + rows[0].negocio_id)
    res.json({ ok: true, agotado: rows[0]?.agotado })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
});

router.delete('/productos/:id', requireAuth, async (req, res) => {
  try {
    const uid = (req as any).userId;
    const check = await sql`
      SELECT p.id, p.negocio_id, COALESCE(v.owner_id, v.user_id) as owner_id
      FROM productos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.id = ${req.params.id}
      LIMIT 1
    `;
    if (!check.length) return res.status(404).json({ error: "Producto no encontrado" });
    if (check[0].owner_id && check[0].owner_id !== uid && !ADMIN_IDS.includes(uid)) {
      return res.status(403).json({ error: "No tienes permiso para eliminar este producto" });
    }

    const rows = await sql`DELETE FROM productos WHERE id = ${req.params.id} RETURNING negocio_id`
    if (rows[0]?.negocio_id) invalidateCache("productos:" + rows[0].negocio_id)
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
