import { Router } from 'express';
import { sql } from '../db';

const router = Router();

router.get('/:negocioId/pedidos', async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM pedidos WHERE negocio_id = ${req.params.negocioId}
      ORDER BY creado_en DESC LIMIT 50`;
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch('/pedidos/:id/status', async (req, res) => {
  try {
    const rows = await sql`
      UPDATE pedidos SET status = ${req.body.status}
      WHERE id = ${req.params.id} RETURNING *`;
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;