import { Router } from 'express';
import { sql } from '../db';
import { notificarSolicitudRestaurante } from '../notificationsAdmin';
import { logError } from '../logger';
import { sincronizarEstadoNegocio } from '../utils/horarios';

const router = Router();

router.post('/solicitud', async (req, res) => {
  try {
    const { userId, tipo, datos, documentos } = req.body;

    if (tipo === 'negocio' || !tipo) {
      if (!datos?.direccion || !String(datos.direccion).trim()) {
        return res.status(400).json({ error: 'La dirección exacta del negocio es obligatoria para calcular costos de envío.' });
      }
      if (datos?.lat == null || datos?.lng == null) {
        return res.status(400).json({ error: 'Debes confirmar la ubicación exacta del restaurante en el mapa.' });
      }
    }

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
      VALUES (${userId}, ${tipo || 'negocio'}, 'pendiente', ${JSON.stringify(datos)}, ${JSON.stringify(documentos)})
      RETURNING *
    `;

    // Notificación en segundo plano al Administrador con botones interactivos
    notificarSolicitudRestaurante({
      solicitud_id: rows[0].id,
      usuario_id: userId,
      nombre_negocio: datos?.nombre_negocio || datos?.nombre || 'Nuevo Restaurante',
      contacto_nombre: datos?.contacto || datos?.email || 'Sin contacto',
      email: datos?.email || '',
      telefono: datos?.telefono || '',
      categoria: datos?.tipo_negocio || datos?.categoria || 'Restaurante',
      direccion: datos?.direccion,
      rfc: datos?.rfc || documentos?.rfc,
      logo_url: documentos?.logo || documentos?.foto,
      ine_frente: documentos?.ine_frente,
      ine_reverso: documentos?.ine_reverso,
      selfie: documentos?.selfie,
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
    const neg = rows[0];
    if (!neg) return res.json(null);
    const sync = await sincronizarEstadoNegocio(neg);
    res.json({
      ...neg,
      esta_abierto: sync.esta_abierto,
      cierre_manual_hoy: sync.cierre_manual_hoy,
      lat: neg.lat ?? neg.latitud ?? null,
      lng: neg.lng ?? neg.longitud ?? null,
      imagen_url: neg.imagen_url ?? neg.logo_url ?? null,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

