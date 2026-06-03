import { Router } from 'express';
import { sql } from '../db';
import { requireAuth } from '../middleware/auth';

const router = Router();

// GET es público — el usuario necesita ver el menú sin autenticarse
router.get('/:negocioId/productos', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM productos WHERE negocio_id = ${req.params.negocioId} ORDER BY categoria, nombre`;
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/productos', requireAuth, async (req, res) => {
  try {
    const { negocio_id, nombre, descripcion, precio, categoria, disponible, destacado, imagen_url } = req.body;
    const rows = await sql`
      INSERT INTO productos (negocio_id, nombre, descripcion, precio, categoria, disponible, destacado, imagen_url)
      VALUES (${negocio_id}, ${nombre}, ${descripcion || ''}, ${precio}, ${categoria}, ${disponible ?? true}, ${destacado ?? false}, ${imagen_url || ''})
      RETURNING *`;
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put('/productos/:id', requireAuth, async (req, res) => {
  try {
    const { nombre, descripcion, precio, categoria, disponible, destacado, imagen_url } = req.body;
    const rows = await sql`
      UPDATE productos SET nombre=${nombre}, descripcion=${descripcion}, precio=${precio},
      categoria=${categoria}, disponible=${disponible}, destacado=${destacado}, imagen_url=${imagen_url || ''}
      WHERE id=${req.params.id} RETURNING *`;
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete('/productos/:id', requireAuth, async (req, res) => {
  try {
    await sql`DELETE FROM productos WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
