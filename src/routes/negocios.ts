import { Router } from 'express';
import { sql } from '../db';
import { notificarSolicitudRestaurante } from '../notificationsAdmin';
import { logError } from '../logger';

const router = Router();

router.post('/solicitud', async (req, res) => {
  try {
    const { userId, tipo, datos, documentos } = req.body;

    await sql`
      INSERT INTO usuarios (id, email, nombre, rol)
      VALUES (${userId}, ${datos?.email || ''}, ${datos?.email || ''}, 'cliente')
      ON CONFLICT (id) DO NOTHING
    `;

    const existing = await sql`
      SELECT id FROM solicitudes
      WHERE usuario_id = ${userId} AND status = 'pendiente'
      LIMIT 1
    `;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Ya tienes una solicitud pendiente.' });
    }

    const rows = await sql`
      INSERT INTO solicitudes (usuario_id, tipo, status, datos, documentos)
      VALUES (${userId}, ${tipo}, 'pendiente', ${JSON.stringify(datos)}, ${JSON.stringify(documentos)})
      RETURNING *
    `;

    // Notificación en segundo plano al Administrador
    notificarSolicitudRestaurante({
      nombre_negocio: datos?.nombre || 'Nuevo Restaurante',
      contacto_nombre: datos?.contacto || datos?.email || 'Sin contacto',
      email: datos?.email || '',
      telefono: datos?.telefono || '',
      categoria: datos?.categoria,
      direccion: datos?.direccion,
      logo_url: documentos?.logo || documentos?.foto,
    }).catch(err => logError(err, 'notificarSolicitudRestaurante'));

    res.json({ ok: true, solicitud: rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/solicitud/:userId', async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM solicitudes
      WHERE usuario_id = ${req.params.userId}
      ORDER BY creado_en DESC LIMIT 1
    `;
    res.json(rows[0] || null);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/negocio/:userId', async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM viveres WHERE owner_id = ${req.params.userId} LIMIT 1
    `;
    res.json(rows[0] || null);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
