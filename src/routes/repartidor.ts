import { Router } from "express";
import { sql } from "../db";

const router = Router();

// POST /api/repartidor/solicitud
router.post("/solicitud", async (req, res) => {
  try {
    const { userId, email, nombre, telefono, vehiculo_tipo, vehiculo_modelo, vehiculo_placas, ine_frente_url, ine_reverso_url, selfie_url, tarjeta_url } = req.body;
    const datos = JSON.stringify({ nombre, telefono, email, vehiculo_tipo, vehiculo_modelo, vehiculo_placas });
    const docs   = JSON.stringify({ ine_frente: ine_frente_url, ine_reverso: ine_reverso_url, selfie: selfie_url, tarjeta_url });
    const existing = await sql`SELECT id FROM solicitudes WHERE usuario_id = ${userId} AND tipo = 'repartidor'`;
    if (existing.length > 0) {
      await sql`UPDATE solicitudes SET datos = ${datos}::jsonb, documentos = ${docs}::jsonb, status = 'pendiente', razon_rechazo = NULL WHERE usuario_id = ${userId} AND tipo = 'repartidor'`;
    } else {
      await sql`INSERT INTO solicitudes (id, usuario_id, tipo, datos, documentos, status) VALUES (gen_random_uuid()::text, ${userId}, 'repartidor', ${datos}::jsonb, ${docs}::jsonb, 'pendiente')`;
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/repartidor/solicitud/:userId
router.get("/solicitud/:userId", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM solicitudes WHERE usuario_id = ${req.params.userId} AND tipo = 'repartidor'`;
    if (!rows.length) return res.status(404).json({ error: "No encontrado" });
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/repartidor/perfil/:userId
router.get("/perfil/:userId", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM repartidores WHERE id = ${req.params.userId}`;
    if (!rows.length) return res.status(404).json({ error: "No encontrado" });
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/repartidor/:userId/status (online/offline)
router.patch("/:userId/status", async (req, res) => {
  try {
    const nuevoStatus = req.body.en_linea ? "online" : "offline";
    await sql`UPDATE repartidores SET status = ${nuevoStatus} WHERE id = ${req.params.userId}`;
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/repartidor/pedidos/disponibles
router.get("/pedidos/disponibles", async (_req, res) => {
  try {
    const rows = await sql`
      SELECT p.*, v.nombre as negocio_nombre, v.direccion as negocio_direccion,
             v.lat as lat_restaurante, v.lng as lng_restaurante
      FROM pedidos p LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.status = 'listo' AND (p.repartidor_id IS NULL OR p.repartidor_id = '')
      ORDER BY p.creado_en DESC
    `;
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/repartidor/pedidos/:id/aceptar
router.patch("/pedidos/:id/aceptar", async (req, res) => {
  try {
    const { repartidorId } = req.body;
    const rows = await sql`
      UPDATE pedidos SET status = 'en_camino', repartidor_id = ${repartidorId}, actualizado_en = NOW()
      WHERE id = ${req.params.id} AND (repartidor_id IS NULL OR repartidor_id = '')
      RETURNING *
    `;
    if (!rows.length) return res.status(409).json({ error: "Pedido ya fue tomado" });
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/repartidor/pedidos/:id/status
router.patch("/pedidos/:id/status", async (req, res) => {
  try {
    const rows = await sql`
      UPDATE pedidos SET status = ${req.body.status}, actualizado_en = NOW()
      WHERE id = ${req.params.id} RETURNING *
    `;
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/repartidor/:userId/pedidos
router.get("/:userId/pedidos", async (req, res) => {
  try {
    const rows = await sql`
      SELECT p.*, v.nombre as negocio_nombre,
             ROUND((p.total * 0.15)::numeric, 2) as comision
      FROM pedidos p LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.repartidor_id = ${req.params.userId}
      ORDER BY p.creado_en DESC LIMIT 30
    `;
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});


function distKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371, dL = (lat2-lat1)*Math.PI/180, dN = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dN/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Marcar en espera del cliente (solo si está en la ubicación)
router.patch("/pedidos/:id/esperando", async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const rows = await sql`SELECT lat_entrega, lng_entrega, status FROM pedidos WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: "Pedido no encontrado" });
    const p = rows[0];
    if (p.status !== "en_camino") return res.status(400).json({ error: "El pedido no está en camino" });
    if (lat && lng && p.lat_entrega && p.lng_entrega) {
      const dist = distKm(Number(lat), Number(lng), Number(p.lat_entrega), Number(p.lng_entrega));
      if (dist > 0.3) return res.status(400).json({ error: "Debes estar a menos de 300m del cliente" });
    }
    await sql`UPDATE pedidos SET status = 'esperando_cliente', esperando_desde = NOW() WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Auto-expirar espera (llamado desde cliente cuando el timer expira)
router.patch("/pedidos/:id/expirar-espera", async (req, res) => {
  try {
    const rows = await sql`SELECT status, esperando_desde FROM pedidos WHERE id = ${req.params.id}`;
    if (!rows.length || rows[0].status !== "esperando_cliente") return res.status(400).json({ error: "No aplica" });
    const minutos = (Date.now() - new Date(rows[0].esperando_desde).getTime()) / 60000;
    if (minutos < 10) return res.status(400).json({ error: "Aún no han pasado 10 minutos" });
    await sql`UPDATE pedidos SET status = 'entregado', actualizado_en = NOW() WHERE id = ${req.params.id}`;
    res.json({ ok: true, expirado: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/repartidor/online — todos los repartidores online con ubicacion
// GET /api/repartidor/online — repartidores online con ubicacion
router.get("/", async (_req, res) => {
  try {
    const rows = await sql`
      SELECT r.id, r.vehiculo, r.placa, r.rating, r.lat_actual, r.lng_actual,
             u.nombre, u.email, u.foto_url
      FROM repartidores r
      LEFT JOIN usuarios u ON u.id = r.id
      WHERE r.status = 'online'
    `
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})


// PATCH /api/repartidor/:userId/ubicacion
router.patch("/:userId/ubicacion", async (req, res) => {
  try {
    const { lat, lng } = req.body
    if (!lat || !lng) return res.status(400).json({ error: "lat y lng requeridos" })
    await sql`UPDATE repartidores SET lat_actual = ${lat}, lng_actual = ${lng} WHERE id = ${req.params.userId}`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /api/repartidor/:userId/ubicacion
router.get("/:userId/ubicacion", async (req, res) => {
  try {
    const rows = await sql`SELECT lat_actual, lng_actual FROM repartidores WHERE id = ${req.params.userId}`
    res.json(rows[0] || { lat_actual: null, lng_actual: null })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})
// GET /api/repartidores/disponibles/count
router.get("/disponibles/count", async (_req, res) => {
  try {
    const rows = await sql`SELECT COUNT(*) as total, array_agg(nombre) as nombres FROM repartidores WHERE en_linea = true AND status = 'aprobado'`
    res.json({ total: Number(rows[0].total), nombres: rows[0].nombres || [] })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router