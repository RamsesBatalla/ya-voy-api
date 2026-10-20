import { Router } from "express";
import { sql } from "../db";
import { notificarCliente } from "../websocket";
import { sendPushToUser } from "../firebase";
import { requireAuthRepartidor } from "../middleware/auth";
import { logError } from "../logger";
import { notificarSolicitudRepartidor, notificarContingenciaAdmin } from "../notificationsAdmin";

// Transiciones válidas por rol repartidor
const TRANS_REPARTIDOR: Record<string, string[]> = {
  preparando:        ["listo", "en_camino", "esperando_cliente", "entregado"],
  listo:             ["en_camino", "esperando_cliente", "entregado"],
  en_camino:         ["esperando_cliente", "entregado", "cancelado"],
  esperando_cliente: ["entregado", "en_camino"],
  entregado:         [],
  cancelado:         [],
}

const router = Router();

// POST /api/repartidor/solicitud
router.post("/solicitud", async (req, res) => {
  try {
    const { userId, email, nombre, telefono, vehiculo_tipo, vehiculo_modelo, vehiculo_placas, ine_frente_url, ine_reverso_url, selfie_url, tarjeta_url } = req.body;
    const datos = JSON.stringify({ nombre, telefono, email, vehiculo_tipo, vehiculo_modelo, vehiculo_placas });
    const docs   = JSON.stringify({ ine_frente: ine_frente_url, ine_reverso: ine_reverso_url, selfie: selfie_url, tarjeta_url });
    let solicitudId = "";
    const existing = await sql`SELECT id FROM solicitudes WHERE usuario_id = ${userId} AND tipo = 'repartidor' ORDER BY creado_en DESC LIMIT 1`;
    if (existing.length > 0) {
      solicitudId = existing[0].id;
      await sql`UPDATE solicitudes SET datos = ${datos}::jsonb, documentos = ${docs}::jsonb, status = 'pendiente', razon_rechazo = NULL, actualizado_en = NOW() WHERE usuario_id = ${userId} AND tipo = 'repartidor'`;
    } else {
      const ins = await sql`INSERT INTO solicitudes (usuario_id, tipo, datos, documentos, status) VALUES (${userId}, 'repartidor', ${datos}::jsonb, ${docs}::jsonb, 'pendiente') RETURNING id`;
      solicitudId = ins[0]?.id || "";
    }

    // Notificación en segundo plano al Administrador
    notificarSolicitudRepartidor({
      solicitud_id: solicitudId,
      usuario_id: userId,
      nombre: nombre || "Sin nombre",
      email: email || "",
      telefono: telefono || "",
      vehiculo_tipo: vehiculo_tipo || "moto",
      vehiculo_modelo,
      vehiculo_placas,
      ine_frente: ine_frente_url,
      ine_reverso: ine_reverso_url,
      selfie: selfie_url,
      tarjeta_url,
    }).catch(err => logError(err, "notificarSolicitudRepartidor"));

    res.json({ ok: true, id: solicitudId });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/repartidor/solicitud/:userId
router.get("/solicitud/:userId", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM solicitudes WHERE usuario_id = ${req.params.userId} AND tipo = 'repartidor' ORDER BY actualizado_en DESC NULLS LAST, creado_en DESC LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: "No encontrado" });
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/repartidor/perfil/:userId
router.get("/perfil/:userId", requireAuthRepartidor, async (req, res) => {
  const uid = (req as any).repUserId;
  if (uid !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" });
  try {
    const rows = await sql`SELECT * FROM repartidores WHERE id = ${req.params.userId} OR usuario_id = ${req.params.userId} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: "No encontrado" });
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/repartidor/:userId/status (online/offline)
router.patch("/:userId/status", requireAuthRepartidor, async (req, res) => {
  const authId = (req as any).repUserId;
  if (authId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" });
  try {
    const isOnline = Boolean(req.body.en_linea);
    const nuevoStatus = isOnline ? "online" : "offline";
    await sql`
      UPDATE repartidores
      SET status = ${nuevoStatus}, en_linea = ${isOnline}, disponible = ${isOnline}, ultima_actividad = NOW()
      WHERE id = ${req.params.userId} OR usuario_id = ${req.params.userId}
    `;
    res.json({ ok: true, status: nuevoStatus, en_linea: isOnline });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});


// ALL /api/repartidor/:userId/beacon-status (desconexión al cerrar app o background prolongado)
router.all("/:userId/beacon-status", async (req, res) => {
  const userId = req.params.userId;
  const enLinea = req.query.en_linea === "true" || req.body?.en_linea === true;
  try {
    await sql`
      UPDATE repartidores
      SET status = ${enLinea ? "online" : "offline"}, en_linea = ${enLinea}, disponible = ${enLinea}, ultima_actividad = NOW()
      WHERE (id = ${userId} OR usuario_id = ${userId})
        AND id NOT IN (
          SELECT DISTINCT repartidor_id FROM pedidos 
          WHERE status IN ('preparando', 'listo', 'en_camino', 'esperando_cliente')
            AND repartidor_id IS NOT NULL
        )
    `;
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

function calcHaversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GET /api/repartidor/pedidos/disponibles
router.get("/pedidos/disponibles", requireAuthRepartidor, async (req, res) => {
  const authRepId = (req as any).repUserId;
  const rLat = req.query.lat != null && req.query.lat !== "" ? Number(req.query.lat) : null;
  const rLng = req.query.lng != null && req.query.lng !== "" ? Number(req.query.lng) : null;

  try {
    const cfgRows = await sql`SELECT valor FROM app_config WHERE clave = 'radio_max_repartidor_km' LIMIT 1`.catch(() => []);
    const radioMaxRepKm = Number(cfgRows[0]?.valor) || 10;

    const rows = await sql`
      SELECT p.*, v.nombre as negocio_nombre, v.direccion as negocio_direccion,
             COALESCE(v.lat, v.latitud) as lat_restaurante,
             COALESCE(v.lng, v.longitud) as lng_restaurante,
             u.telefono as cliente_telefono,
             u.nombre as cliente_nombre
      FROM pedidos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      LEFT JOIN usuarios u ON u.id = p.cliente_id
      WHERE p.status IN ('preparando', 'listo')
        AND (p.repartidor_id IS NULL OR p.repartidor_id = '')
        AND COALESCE(p.tipo_entrega, 'domicilio') != 'pickup'
        AND p.id::text NOT IN (
          SELECT pedido_id FROM pedidos_rechazados WHERE repartidor_id = ${authRepId}
        )
      ORDER BY p.creado_en DESC
      LIMIT 50
    `;

    const procesados = rows
      .map((p: any) => {
        let distRepRestKm: number | null = null;
        let distRestCliKm: number | null = null;

        if (rLat != null && rLng != null && !isNaN(rLat) && !isNaN(rLng) && p.lat_restaurante != null && p.lng_restaurante != null) {
          distRepRestKm = Math.round(calcHaversineKm(rLat, rLng, Number(p.lat_restaurante), Number(p.lng_restaurante)) * 10) / 10;
        }
        if (p.lat_restaurante != null && p.lng_restaurante != null && p.lat_entrega != null && p.lng_entrega != null) {
          distRestCliKm = Math.round(calcHaversineKm(Number(p.lat_restaurante), Number(p.lng_restaurante), Number(p.lat_entrega), Number(p.lng_entrega)) * 10) / 10;
        }

        return {
          ...p,
          distancia_al_restaurante_km: distRepRestKm,
          distancia_entrega_km: distRestCliKm,
          costo_envio: p.costo_envio ?? 25,
        };
      })
      .filter((p: any) => {
        if (p.distancia_al_restaurante_km != null && p.distancia_al_restaurante_km > radioMaxRepKm) {
          return false;
        }
        return true;
      });

    res.json(procesados);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/repartidor/pedidos/:id/rechazar - conductor rechaza un pedido detectado
router.post("/pedidos/:id/rechazar", requireAuthRepartidor, async (req, res) => {
  const authRepId = (req as any).repUserId;
  try {
    await sql`
      INSERT INTO pedidos_rechazados (pedido_id, repartidor_id)
      VALUES (${req.params.id}, ${authRepId})
      ON CONFLICT (pedido_id, repartidor_id) DO NOTHING
    `;
    res.json({ ok: true, rechazado: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/repartidor/pedidos/:id/aceptar
router.patch("/pedidos/:id/aceptar", requireAuthRepartidor, async (req, res) => {
  try {
    const authRepId = (req as any).repUserId;
    const repartidorId = req.body.repartidorId || authRepId;

    // Gestión inteligente de múltiples pedidos según distancia y tiempos:
    // Se permite llevar hasta 2 pedidos activos SOLO si el restaurante nuevo está a <= 1.8 km
    // del restaurante actual y el cliente nuevo está a <= 2.5 km del cliente actual.
    const activos = await sql`
      SELECT p.id, p.lat_entrega, p.lng_entrega,
             COALESCE(v.lat, v.latitud) as lat_rest,
             COALESCE(v.lng, v.longitud) as lng_rest
      FROM pedidos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.repartidor_id = ${repartidorId}
        AND p.status IN ('preparando', 'listo', 'en_camino', 'esperando_cliente')
        AND p.id::text != ${req.params.id}
    `;
    if (activos.length >= 2) {
      return res.status(409).json({
        error: "Ya llevas el máximo de 2 pedidos activos en ruta. Completa una entrega antes de aceptar otro."
      });
    }
    if (activos.length === 1) {
      const act = activos[0];
      const candRows = await sql`
        SELECT p.id, p.lat_entrega, p.lng_entrega,
               COALESCE(v.lat, v.latitud) as lat_rest,
               COALESCE(v.lng, v.longitud) as lng_rest
        FROM pedidos p
        LEFT JOIN viveres v ON v.id = p.negocio_id
        WHERE p.id::text = ${req.params.id}
        LIMIT 1
      `;
      const cand = candRows[0];
      if (cand) {
        const hasRestCoords = act.lat_rest != null && act.lng_rest != null && cand.lat_rest != null && cand.lng_rest != null;
        const hasCliCoords = act.lat_entrega != null && act.lng_entrega != null && cand.lat_entrega != null && cand.lng_entrega != null;
        if (!hasRestCoords || !hasCliCoords) {
          return res.status(409).json({
            error: "Ya tienes un pedido activo en curso. Termínalo antes de aceptar otro."
          });
        }
        const distRestKm = calcHaversineKm(Number(act.lat_rest), Number(act.lng_rest), Number(cand.lat_rest), Number(cand.lng_rest));
        const distCliKm = calcHaversineKm(Number(act.lat_entrega), Number(act.lng_entrega), Number(cand.lat_entrega), Number(cand.lng_entrega));
        if (distRestKm > 1.8 || distCliKm > 2.5) {
          return res.status(409).json({
            error: `Este pedido está lejos de tu entrega actual (restaurantes a ${distRestKm.toFixed(1)} km / destinos a ${distCliKm.toFixed(1)} km). Solo puedes llevar 2 pedidos simultáneos cuando ambos quedan cercanos en la misma ruta.`
          });
        }
      }
    }

    // Actualización atómica: el primero que presiona se queda el pedido (excluyendo pedidos pickup)
    const rows = await sql`
      UPDATE pedidos
      SET repartidor_id = ${repartidorId},
          asignado_en = NOW(),
          actualizado_en = NOW()
      WHERE id::text = ${req.params.id}
        AND (repartidor_id IS NULL OR repartidor_id = '')
        AND COALESCE(tipo_entrega, 'domicilio') != 'pickup'
        AND status IN ('preparando', 'listo', 'nuevo')
      RETURNING *
    `;
    if (!rows.length) {
      return res.status(409).json({ error: "Este pedido ya fue aceptado por otro repartidor o fue cancelado." });
    }

    // Enriquecer con datos del restaurante y cliente para el mapa y la tarjeta activa
    const enriched = await sql`
      SELECT p.*, v.nombre as negocio_nombre, v.direccion as negocio_direccion,
             COALESCE(v.lat, v.latitud) as lat_restaurante,
             COALESCE(v.lng, v.longitud) as lng_restaurante,
             v.owner_id as negocio_owner_id,
             u.telefono as cliente_telefono,
             u.nombre as cliente_nombre,
             ROUND((p.total * (SELECT COALESCE(valor::numeric, 18) / 100 FROM app_config WHERE clave = 'comision_pct'))::numeric, 2) as comision
      FROM pedidos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      LEFT JOIN usuarios u ON u.id = p.cliente_id
      WHERE p.id = ${rows[0].id}
      LIMIT 1
    `;
    const pedidoAceptado = enriched[0] || rows[0];
    res.json(pedidoAceptado);

    // Notificar en tiempo real al cliente y al restaurante que un repartidor aceptó el pedido
    if (pedidoAceptado.cliente_id) {
      notificarCliente(pedidoAceptado.cliente_id, "pedido_update", pedidoAceptado);
      sendPushToUser(sql, pedidoAceptado.cliente_id, "🛵 Repartidor asignado", "Un repartidor aceptó tu pedido y va rumbo al restaurante.", { pedidoId: String(pedidoAceptado.id), status: pedidoAceptado.status }).catch(() => {});
    }
    if (pedidoAceptado.negocio_owner_id) {
      notificarCliente(pedidoAceptado.negocio_owner_id, "pedido_update", pedidoAceptado);
      sendPushToUser(sql, pedidoAceptado.negocio_owner_id, "🛵 Repartidor en camino al local", `Un repartidor aceptó el pedido #${String(pedidoAceptado.id).slice(-5).toUpperCase()}. Pídele la clave de recolección al entregar.`, { pedidoId: String(pedidoAceptado.id), status: pedidoAceptado.status }).catch(() => {});
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/repartidor/pedidos/:id/status
router.patch("/pedidos/:id/status", requireAuthRepartidor, async (req, res) => {
  try {
    const { status } = req.body
    const current = await sql`SELECT status FROM pedidos WHERE id::text = ${req.params.id}`
    if (!current.length) return res.status(404).json({ error: "Pedido no encontrado" })
    const estadoActual = current[0].status
    if (!TRANS_REPARTIDOR[estadoActual]?.includes(status))
      return res.status(400).json({ error: `No se puede pasar de '${estadoActual}' a '${status}'` })

    const rows = await sql`
      UPDATE pedidos SET status = ${status}, actualizado_en = NOW()
      WHERE id::text = ${req.params.id} RETURNING *
    `;
    res.json(rows[0]);
    if (rows[0]?.cliente_id) notificarCliente(rows[0].cliente_id, "pedido_update", rows[0]);

  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/repartidor/:userId/pedidos
router.get("/:userId/pedidos", async (req, res) => {
  try {
    const rows = await sql`
      SELECT p.*, v.nombre as negocio_nombre, v.direccion as negocio_direccion,
             COALESCE(v.lat, v.latitud) as lat_restaurante,
             COALESCE(v.lng, v.longitud) as lng_restaurante,
             u.telefono as cliente_telefono,
             u.nombre as cliente_nombre,
             ROUND((p.total * (SELECT COALESCE(valor::numeric, 18) / 100 FROM app_config WHERE clave = 'comision_pct'))::numeric, 2) as comision
      FROM pedidos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      LEFT JOIN usuarios u ON u.id = p.cliente_id
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
router.patch("/pedidos/:id/esperando", requireAuthRepartidor, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const rows = await sql`SELECT lat_entrega, lng_entrega, status FROM pedidos WHERE id::text = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: "Pedido no encontrado" });
    const p = rows[0];
    if (p.status !== "en_camino") return res.status(400).json({ error: "El pedido no está en camino" });
    if (lat && lng && p.lat_entrega && p.lng_entrega) {
      const dist = distKm(Number(lat), Number(lng), Number(p.lat_entrega), Number(p.lng_entrega));
      if (dist > 0.3) return res.status(400).json({ error: "Debes estar a menos de 300m del cliente" });
    }
    const updated = await sql`
      UPDATE pedidos SET status = 'esperando_cliente', esperando_desde = NOW()
      WHERE id::text = ${req.params.id}
      RETURNING cliente_id, negocio_id`
    const pedidoUpd = updated[0]
    if (pedidoUpd?.cliente_id) {
      notificarCliente(pedidoUpd.cliente_id, "pedido_update", { id: req.params.id, status: "esperando_cliente", esperando_desde: new Date().toISOString() })
      await sendPushToUser(sql, pedidoUpd.cliente_id, "📍 Tu repartidor está afuera", "Tu repartidor llegó a tu ubicación y te está esperando (tienes 10 minutos para recibir tu pedido).", { pedidoId: req.params.id, status: "esperando_cliente" }).catch(() => {})
    }
    if (pedidoUpd?.negocio_id) {
      const negocio = await sql`SELECT owner_id FROM viveres WHERE id = ${pedidoUpd.negocio_id}`
      if (negocio[0]?.owner_id) {
        notificarCliente(negocio[0].owner_id, "pedido_update", { id: req.params.id, status: "esperando_cliente" })
        await sendPushToUser(sql, negocio[0].owner_id, "Repartidor llegó con el cliente", "El repartidor está esperando al cliente en la dirección de entrega.", { pedidoId: req.params.id }).catch(() => {})
      }
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Auto-expirar espera (llamado desde cliente cuando el timer expira, exigiendo foto de evidencia)
router.patch("/pedidos/:id/expirar-espera", requireAuthRepartidor, async (req, res) => {
  try {
    const rows = await sql`SELECT status, esperando_desde, foto_entrega, foto_entrega_url, cliente_id, repartidor_id FROM pedidos WHERE id::text = ${req.params.id}`;
    if (!rows.length || rows[0].status !== "esperando_cliente") return res.status(400).json({ error: "No aplica" });
    const p = rows[0];
    const fotoEvidencia = p.foto_entrega || p.foto_entrega_url || req.body?.fotoUrl;
    if (!fotoEvidencia) {
      return res.status(400).json({
        error: "Debes tomar y subir la foto de evidencia en el punto de entrega antes de finalizar el tiempo de espera."
      });
    }
    const minutos = (Date.now() - new Date(p.esperando_desde).getTime()) / 60000;
    if (minutos < 10) return res.status(400).json({ error: "Aún no han pasado 10 minutos" });
    const [updated] = await sql`UPDATE pedidos SET status = 'entregado', entregado_en = NOW(), actualizado_en = NOW() WHERE id::text = ${req.params.id} RETURNING *`;
    if (p.cliente_id) {
      notificarCliente(p.cliente_id, "pedido_update", updated);
    }
    notificarContingenciaAdmin({
      titulo: "Espera de 10 min expirada (Cliente no salió)",
      pedidoId: String(req.params.id),
      detalle: "El repartidor esperó 10 minutos en el punto de entrega con foto de evidencia verificada.",
      actorTipo: "cliente",
      actorId: p.cliente_id,
      fotoEvidenciaUrl: fotoEvidencia,
    }).catch(() => {});
    res.json({ ok: true, expirado: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/repartidor/online — repartidores online con ubicacion
router.get("/", async (_req, res) => {
  try {
    const rows = await sql`
      SELECT r.id, COALESCE(r.vehiculo, r.vehiculo_tipo) as vehiculo, COALESCE(r.placa, r.vehiculo_placas, r.placas) as placa, r.rating,
             COALESCE(r.lat_actual, r.latitud, r.lat) as lat_actual,
             COALESCE(r.lng_actual, r.longitud, r.lng) as lng_actual,
             COALESCE(u.nombre, r.nombre) as nombre, COALESCE(u.email, r.email) as email, COALESCE(u.foto_url, r.foto_url) as foto_url
      FROM repartidores r
      LEFT JOIN usuarios u ON u.id = r.id
      WHERE r.status = 'online' OR r.en_linea = true
    `
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})


// PATCH /api/repartidor/:userId/ubicacion
router.patch("/:userId/ubicacion", requireAuthRepartidor, async (req, res) => {
  if ((req as any).repUserId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const { lat, lng } = req.body
    if (!lat || !lng) return res.status(400).json({ error: "lat y lng requeridos" })
    await sql`
      UPDATE repartidores
      SET lat_actual = ${lat}, lng_actual = ${lng}, latitud = ${lat}, longitud = ${lng}, lat = ${lat}, lng = ${lng}, ultima_actividad = NOW()
      WHERE id = ${req.params.userId} OR usuario_id = ${req.params.userId}
    `
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /api/repartidor/:userId/ubicacion
router.get("/:userId/ubicacion", async (req, res) => {
  try {
    const rows = await sql`
      SELECT COALESCE(lat_actual, latitud, lat) as lat_actual,
             COALESCE(lng_actual, longitud, lng) as lng_actual
      FROM repartidores
      WHERE id = ${req.params.userId} OR usuario_id = ${req.params.userId}
      LIMIT 1
    `
    res.json(rows[0] || { lat_actual: null, lng_actual: null })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})
// GET /api/repartidor/disponibles/count (con cálculo de proximidad real)
router.get("/disponibles/count", async (req, res) => {
  try {
    let targetLat = req.query.lat != null && req.query.lat !== "" ? Number(req.query.lat) : null;
    let targetLng = req.query.lng != null && req.query.lng !== "" ? Number(req.query.lng) : null;

    if ((targetLat == null || targetLng == null) && req.query.negocioId) {
      const negRows = await sql`SELECT COALESCE(lat, latitud) as lat, COALESCE(lng, longitud) as lng FROM viveres WHERE id::text = ${String(req.query.negocioId)} LIMIT 1`.catch(() => []);
      if (negRows.length && negRows[0].lat != null && negRows[0].lng != null) {
        targetLat = Number(negRows[0].lat);
        targetLng = Number(negRows[0].lng);
      }
    }

    const rows = await sql`
      SELECT r.id, COALESCE(u.nombre, r.nombre) as nombre,
             COALESCE(r.lat_actual, r.latitud, r.lat) as lat,
             COALESCE(r.lng_actual, r.longitud, r.lng) as lng
      FROM repartidores r
      LEFT JOIN usuarios u ON u.id = r.id
      WHERE (r.status = 'online' OR r.en_linea = true)
        AND (r.ultima_actividad IS NULL OR r.ultima_actividad >= NOW() - INTERVAL '15 minutes')
        AND COALESCE(r.bloqueado, false) = false
    `;

    if (targetLat != null && targetLng != null && !isNaN(targetLat) && !isNaN(targetLng) && targetLat !== 0 && targetLng !== 0) {
      const radioMaxKm = 10;
      const cercanos = rows.filter((r: any) => {
        if (r.lat == null || r.lng == null) return false;
        const d = calcHaversineKm(targetLat!, targetLng!, Number(r.lat), Number(r.lng));
        return d <= radioMaxKm;
      });
      return res.json({ total: cercanos.length, nombres: cercanos.map((r: any) => r.nombre).filter(Boolean) });
    }

    res.json({ total: rows.length, nombres: rows.map((r: any) => r.nombre).filter(Boolean) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/repartidor/:repartidorId/calificaciones-aspectos — desglose de aspectos del repartidor
router.get("/:repartidorId/calificaciones-aspectos", async (req, res) => {
  try {
    const [rep] = await sql`SELECT rating FROM repartidores WHERE id = ${req.params.repartidorId} OR usuario_id = ${req.params.repartidorId} LIMIT 1`;
    const pedidosRows = await sql`
      SELECT rating_repartidor, aspectos_repartidor 
      FROM pedidos 
      WHERE repartidor_id = ${req.params.repartidorId} AND rating_repartidor IS NOT NULL
      ORDER BY creado_en DESC LIMIT 100
    `;
    const ratingPromedio = rep?.rating ? Number(Number(rep.rating).toFixed(1)) : 0.0;
    const aspectosConteo: Record<string, number> = {
      "Rapidez": 0,
      "Amabilidad": 0,
      "Cuidado del pedido": 0,
      "Buena comunicación": 0
    };
    let totalRatings = pedidosRows.length;
    for (const p of pedidosRows) {
      const asp = Array.isArray(p.aspectos_repartidor) ? p.aspectos_repartidor : (typeof p.aspectos_repartidor === 'string' ? JSON.parse(p.aspectos_repartidor) : []);
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

export default router

