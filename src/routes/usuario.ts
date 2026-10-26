import { Router } from "express";
import rateLimit from "express-rate-limit";
import Stripe from "stripe";
import { sql, supabase } from "../db";
import { deleteSupabaseStorageFile } from "../services/solicitudesService";
import { notificarBloqueoAdmin } from "../notificationsAdmin";
import { sendPushToUser } from "../firebase";
import { notificarCliente } from "../websocket";
import { requireAuth, requireAuthUsuario } from "../middleware/auth";
import { getCache, setCache, invalidateCache } from "../cache";
import { logError } from "../logger";
import { sincronizarEstadoNegocio, getMexicoNow } from "../utils/horarios";

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || "", { apiVersion: "2026-04-22.dahlia" });

const limitPedidos = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Demasiados pedidos, intenta en 15 minutos" } })
const limitCupones = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: "Demasiados intentos, intenta en 15 minutos" } })

const router = Router();



const initTablas = async () => {

  await sql`CREATE TABLE IF NOT EXISTS favoritos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id TEXT NOT NULL,
    negocio_id TEXT NOT NULL,
    creado_en TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(cliente_id, negocio_id)
  )`
  await sql`CREATE INDEX IF NOT EXISTS idx_favoritos_cliente ON favoritos(cliente_id)`

  await sql`CREATE TABLE IF NOT EXISTS direcciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id TEXT NOT NULL,
    label TEXT NOT NULL,
    icono TEXT NOT NULL DEFAULT 'otro',
    direccion TEXT NOT NULL,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    principal BOOLEAN NOT NULL DEFAULT false,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`
  await sql`CREATE INDEX IF NOT EXISTS idx_direcciones_usuario ON direcciones(usuario_id)`

  await sql`CREATE TABLE IF NOT EXISTS cupones (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    codigo TEXT UNIQUE NOT NULL,

    tipo TEXT NOT NULL,

    valor NUMERIC NOT NULL,

    usos_max INT DEFAULT 1,

    usos_actual INT DEFAULT 0,

    expira_en TIMESTAMPTZ,

    activo BOOLEAN DEFAULT true,

    creado_en TIMESTAMPTZ DEFAULT NOW()

  )`

  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS costo_envio NUMERIC DEFAULT 20`

  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tiempo_estimado TEXT`

}

initTablas().catch(e => console.error("Error init tablas:", e.message))

function calcHaversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

router.get("/productos/feed", async (req, res) => {
  try {
    const uLat = req.query.lat != null && req.query.lat !== "" ? Number(req.query.lat) : null;
    const uLng = req.query.lng != null && req.query.lng !== "" ? Number(req.query.lng) : null;
    const cfgRows = await sql`SELECT valor FROM app_config WHERE clave = 'radio_max_usuario_km' LIMIT 1`.catch(() => []);
    const radioMaxKm = Number(cfgRows[0]?.valor) || 10;

    const rows = await sql`
      SELECT p.*, v.nombre as negocio_nombre, v.id as negocio_id,
             v.imagen_url as negocio_imagen, COALESCE(v.rating, 0.0) as negocio_rating,
             v.esta_abierto as negocio_abierto,
             COALESCE(v.lat, v.latitud) as negocio_lat,
             COALESCE(v.lng, v.longitud) as negocio_lng
      FROM productos p
      JOIN viveres v ON v.id::text = p.negocio_id::text
      WHERE p.disponible = true AND v.status = 'aprobado'
      ORDER BY v.esta_abierto DESC, p.destacado DESC, v.rating DESC NULLS LAST, p.nombre
      LIMIT 100
    `;

    const filtrados = rows.filter((r: any) => {
      if (uLat != null && uLng != null && !isNaN(uLat) && !isNaN(uLng) && r.negocio_lat != null && r.negocio_lng != null) {
        const d = calcHaversineKm(uLat, uLng, Number(r.negocio_lat), Number(r.negocio_lng));
        if (d > radioMaxKm) return false;
      }
      return true;
    }).slice(0, 80);

    res.json(filtrados);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/negocios", async (req, res) => {
  try {
    const q = ((req.query.q as string) || "").trim();
    const uLat = req.query.lat != null && req.query.lat !== "" ? Number(req.query.lat) : null;
    const uLng = req.query.lng != null && req.query.lng !== "" ? Number(req.query.lng) : null;
    const mx = getMexicoNow();

    let rows: any[] = [];
    if (q.length >= 2) {
      rows = await sql`
        SELECT * FROM viveres
        WHERE status = 'aprobado'
          AND (nombre % ${q} OR nombre ILIKE ${'%' + q + '%'})
        ORDER BY esta_abierto DESC, similarity(nombre, ${q}) DESC, rating DESC NULLS LAST
        LIMIT 50`;
    } else {
      rows = await sql`
        SELECT * FROM viveres
        WHERE status = 'aprobado'
        ORDER BY esta_abierto DESC, aceptando_pedidos DESC NULLS LAST, rating DESC NULLS LAST
        LIMIT 100`;
    }

    const cfgEnvio = await sql`SELECT clave, valor FROM app_config WHERE clave IN ('envio_minimo', 'envio_por_km', 'radio_max_usuario_km')`.catch(() => []);
    let envioMinimo = 20;
    let envioPorKm = 8;
    let radioMaxUsuarioKm = 10;
    cfgEnvio.forEach((c: any) => {
      if (c.clave === 'envio_minimo') envioMinimo = Number(c.valor) || 25;
      if (c.clave === 'envio_por_km') envioPorKm = Number(c.valor) || 8;
      if (c.clave === 'radio_max_usuario_km') radioMaxUsuarioKm = Number(c.valor) || 10;
    });

    const procesadosRaw = await Promise.all(
      rows.map(async (n: any) => {
        const sync = await sincronizarEstadoNegocio(n, mx);
        const nLat = n.lat ?? n.latitud;
        const nLng = n.lng ?? n.longitud;
        let distKm: number | null = null;
        let costoEnvioEstimado = envioMinimo;

        if (uLat != null && uLng != null && !isNaN(uLat) && !isNaN(uLng) && nLat != null && nLng != null) {
          distKm = Math.round(calcHaversineKm(uLat, uLng, Number(nLat), Number(nLng)) * 10) / 10;
          costoEnvioEstimado = Math.max(envioMinimo, Math.round(distKm * envioPorKm));
        }

        return {
          ...n,
          esta_abierto: sync.esta_abierto,
          cierre_manual_hoy: sync.cierre_manual_hoy,
          lat: nLat,
          lng: nLng,
          distancia_km: distKm,
          costo_envio: costoEnvioEstimado,
          costo_envio_base: envioMinimo,
          imagen_url: n.imagen_url ?? n.logo_url ?? null,
        };
      })
    );

    // Filtrar negocios que excedan el radio máximo permitido para el usuario (ej. 10 km)
    const procesados = procesadosRaw.filter((n: any) => {
      if (n.distancia_km != null && n.distancia_km > radioMaxUsuarioKm) {
        return false;
      }
      return true;
    });

    // Si el usuario proporcionó ubicación, ordenar preferentemente por abiertos y distancia
    if (uLat != null && uLng != null && !q) {
      procesados.sort((a, b) => {
        if (a.esta_abierto !== b.esta_abierto) return a.esta_abierto ? -1 : 1;
        if (a.distancia_km != null && b.distancia_km != null) return a.distancia_km - b.distancia_km;
        return 0;
      });
    }

    res.json(procesados);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/usuario/buscar?q= — búsqueda fuzzy en negocios + productos
router.get("/buscar", async (req, res) => {
  try {
    const q = ((req.query.q as string) || "").trim()
    if (q.length < 2) return res.json({ negocios: [], productos: [] })

    const negocios = await sql`
      SELECT id, nombre, imagen_url, categoria, rating, tiempo_estimado, esta_abierto
      FROM viveres
      WHERE status = 'aprobado'
        AND (nombre % ${q} OR nombre ILIKE ${'%' + q + '%'})
      ORDER BY similarity(nombre, ${q}) DESC, rating DESC
      LIMIT 20`

    const productos = await sql`
      SELECT p.id, p.nombre, p.precio, p.imagen_url, p.negocio_id,
             v.nombre as negocio_nombre, v.esta_abierto
      FROM productos p
      JOIN viveres v ON v.id::text = p.negocio_id
      WHERE p.disponible = true
        AND v.status = 'aprobado'
        AND (p.nombre % ${q} OR p.nombre ILIKE ${'%' + q + '%'})
      ORDER BY similarity(p.nombre, ${q}) DESC
      LIMIT 20`

    res.json({ negocios, productos })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
});



router.get("/negocios/:id", async (req, res) => {

  try {

    const rows = await sql`SELECT * FROM viveres WHERE id = ${req.params.id}`;

    res.json(rows[0] || null);

  } catch (e: any) { res.status(500).json({ error: e.message }); }

});



router.get("/negocios/:id/productos", async (req, res) => {

  try {

    const key = "productos:" + req.params.id
    const cached = getCache<any[]>(key)
    if (cached) return res.json(cached)

    const rows = await sql`SELECT * FROM productos WHERE negocio_id = ${req.params.id} AND disponible = true ORDER BY agotado ASC, destacado DESC, categoria, nombre`;
    setCache(key, rows)
    res.json(rows);

  } catch (e: any) { res.status(500).json({ error: e.message }); }

});



const PALABRAS = ["TIGRE","LUNA","SOL","PUMA","RAYO","NUBE","MAR","RIO","VIENTO","FUEGO","TIERRA","AGUILA","LOBO","OSO","ZORRO","LEON","TORO","COBRA","FLOR","ROCA","PIEDRA","AGUA","BRISA","MONTE","CIELO"];

const genCodigo = () => PALABRAS[Math.floor(Math.random()*PALABRAS.length)];

const genTres = (base: string): string[] => {

  const otros = PALABRAS.filter(w => w !== base);

  const shuffled = otros.sort(() => Math.random() - 0.5);

  const dos = [shuffled[0], shuffled[1]];

  return [base, ...dos].sort(() => Math.random() - 0.5);

};

const genDos = () => {

  const a = genCodigo();

  let b = genCodigo();

  while (b === a) b = genCodigo();

  return [a, b];

};



router.post("/cupones/validar", limitCupones, async (req, res) => {

  try {

    const { codigo, total, negocioId } = req.body

    if (!codigo) return res.status(400).json({ error: "Codigo requerido" })

    const rows = await sql`SELECT * FROM cupones WHERE codigo = ${codigo.toUpperCase().trim()} AND activo = true`

    if (!rows.length) return res.status(404).json({ error: "Cupon invalido o no existe" })

    const cupon = rows[0]

    if (cupon.expira_en && new Date(cupon.expira_en) < new Date())

      return res.status(400).json({ error: "Este cupon ha expirado" })

    if (cupon.usos_max && cupon.usos_actual >= cupon.usos_max)

      return res.status(400).json({ error: "Este cupon ya no tiene usos disponibles" })

    if (cupon.negocio_id && negocioId && cupon.negocio_id !== negocioId)

      return res.status(400).json({ error: "Este cupon no aplica para este restaurante" })

    if (cupon.minimo_compra && Number(total) < Number(cupon.minimo_compra))

      return res.status(400).json({ error: "Compra minima para este cupon: $" + Number(cupon.minimo_compra).toFixed(2) })

    const descuento = cupon.tipo === "porcentaje"

      ? Math.min(Number(total) * Number(cupon.valor) / 100, Number(total))

      : Math.min(Number(cupon.valor), Number(total))

    res.json({ valido: true, descuento: Number(descuento.toFixed(2)), tipo: cupon.tipo, valor: Number(cupon.valor), codigo: cupon.codigo, nombre: cupon.nombre, descripcion: cupon.descripcion })

  } catch (e: any) { res.status(500).json({ error: e.message }) }

})



router.post("/pedidos", requireAuth, limitPedidos, async (req, res) => {

  try {

    const authUserId = (req as any).userId;
    const { clienteId, negocioId, items, total, direccionEntrega, notas, metodoPago, latEntrega, lngEntrega, cuponCodigo, descuentoCupon, costoEnvio, tiempoEstimado, tiempoEstimadoMin, paymentIntentId, propina, status: statusInicial, tipoEntrega, programadoPara, walletMonto } = req.body;

    if (authUserId !== clienteId) return res.status(403).json({ error: "No autorizado" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "El pedido debe tener al menos un producto" });
    if (!total || Number(total) <= 0) return res.status(400).json({ error: "Total inválido" });

    // ── Recalcular total desde precios reales en la BD ────────────────────
    const productoIds = [...new Set(items.map((i: any) => i.productoId).filter(Boolean))]
    const dbProductos = productoIds.length
      ? await sql`SELECT id, precio FROM productos WHERE id = ANY(${productoIds as string[]})`
      : []
    const precioMap: Record<string, number> = {}
    dbProductos.forEach((p: any) => { precioMap[p.id] = Number(p.precio) })

    const envio = costoEnvio ?? 20;
    let subtotalCalculado = 0
    for (const item of items) {
      const precioBase = precioMap[item.productoId] ?? Number(item.precioBase ?? item.precio ?? 0)
      let ops = item.opciones;
      if (typeof ops === 'string') {
        try { ops = JSON.parse(ops); } catch { ops = []; }
      }
      const extras = (Array.isArray(ops) ? ops : []).reduce((s: number, o: any) => s + Number(o.precio || 0), 0)
      subtotalCalculado += (precioBase + extras) * Number(item.cantidad || 1)
    }
    const totalCalculado = Math.round((subtotalCalculado + Number(envio) + Number(propina || 0) - Number(descuentoCupon || 0)) * 100) / 100
    const totalEnviado  = Math.round(Number(total) * 100) / 100
    if (Math.abs(totalCalculado - totalEnviado) > 2)
      return res.status(400).json({ error: "El total no coincide con los precios actuales. Refresca la app." });

    await sql`INSERT INTO usuarios (id, email, nombre, rol) VALUES (${clienteId}, '', '', 'cliente') ON CONFLICT (id) DO NOTHING`;

    const [codEntrega, codRest] = genDos();

    const palabrasEntrega = genTres(codEntrega);

    const palabrasRestaurante = genTres(codRest);

    const negocioRows = await sql`
      SELECT id, COALESCE(owner_id, user_id) as owner_id, esta_abierto, aceptando_pedidos, COALESCE(horarios, '{}'::jsonb) as horarios,
             cierre_manual_fecha, apertura_manual_fecha, nombre,
             COALESCE(lat, latitud) as lat, COALESCE(lng, longitud) as lng
      FROM viveres WHERE id::text = ${negocioId}
    `
    if (!negocioRows.length) return res.status(404).json({ error: "Restaurante no encontrado." })
    
    const mx = getMexicoNow();
    const syncNegocio = await sincronizarEstadoNegocio(negocioRows[0], mx);
    if (!syncNegocio.esta_abierto) {
      const msg = syncNegocio.mensajeCierre || "Este restaurante está cerrado en este momento.";
      return res.status(400).json({ error: msg });
    }
    if (negocioRows[0].aceptando_pedidos === false) {
      return res.status(400).json({ error: "Este restaurante pausó temporalmente los pedidos. Intenta en unos minutos." });
    }

    // Validar distancia máxima permitida entre restaurante y dirección de entrega
    const cfgRadio = await sql`SELECT valor FROM app_config WHERE clave = 'radio_max_usuario_km' LIMIT 1`.catch(() => []);
    const radioMaxUsuarioKm = Number(cfgRadio[0]?.valor) || 10;
    let distRestClienteKm: number | null = null;
    if (latEntrega != null && lngEntrega != null && negocioRows[0].lat != null && negocioRows[0].lng != null) {
      distRestClienteKm = Math.round(calcHaversineKm(Number(latEntrega), Number(lngEntrega), Number(negocioRows[0].lat), Number(negocioRows[0].lng)) * 10) / 10;
      if (distRestClienteKm > radioMaxUsuarioKm) {
        return res.status(400).json({ error: `Este restaurante se encuentra a ${distRestClienteKm} km de tu dirección (el límite máximo de entrega es ${radioMaxUsuarioKm} km).` });
      }
    }

    // Prevención de fraude: Tope máximo de $400 MXN en efectivo para clientes nuevos (< 3 pedidos entregados)
    if ((metodoPago || 'efectivo') === 'efectivo' && Number(totalCalculado) > 400) {
      const histRows = await sql`SELECT COUNT(*) as cnt FROM pedidos WHERE cliente_id = ${clienteId} AND status = 'entregado'`.catch(() => [{ cnt: 0 }]);
      const entregadosCount = Number(histRows[0]?.cnt || 0);
      if (entregadosCount < 3) {
        return res.status(400).json({
          error: "Por seguridad, en tus primeros 3 pedidos el límite máximo para pago en efectivo es de $400 MXN. Para montos mayores por favor utiliza pago con tarjeta."
        });
      }
    }

    const cfgLimite = await sql`SELECT valor FROM app_config WHERE clave = 'max_pedidos_simultaneos'`
    const maxPedidos = cfgLimite.length ? parseInt(cfgLimite[0].valor) : 10
    const pedidosRest = await sql`SELECT COUNT(*) as cnt FROM pedidos WHERE negocio_id = ${negocioId} AND status NOT IN ('entregado','cancelado','pendiente_pago')`
    if (parseInt(pedidosRest[0].cnt) >= maxPedidos) return res.status(429).json({ error: "Este restaurante tiene demasiados pedidos activos en este momento. Intenta en unos minutos." })

    const totalNum = Number(totalCalculado) || 0;
    const subtotalNum = Math.max(0, totalNum - (tipoEntrega === 'pickup' ? 0 : envio) - (Number(propina) || 0));

    const rows = await sql`
      INSERT INTO pedidos (
        cliente_id, negocio_id, items,
        total, monto_total, subtotal, costo_envio, propina,
        direccion_entrega, notas, metodo_pago, status,
        codigo_entrega, codigo_restaurante, palabras_verificacion,
        lat_entrega, lng_entrega, latitud_entrega, longitud_entrega,
        tiempo_estimado, tiempo_estimado_min, distancia_km, payment_intent_id,
        tipo_entrega, programado_para, wallet_monto, cupon_codigo
      ) VALUES (
        ${clienteId}, ${negocioId}, ${JSON.stringify(items)},
        ${totalNum}, ${totalNum}, ${subtotalNum}, ${tipoEntrega === 'pickup' ? 0 : envio}, ${Number(propina) || 0},
        ${direccionEntrega || ''}, ${notas || ''}, ${metodoPago || 'efectivo'},
        ${statusInicial === 'pendiente_pago' ? 'pendiente_pago' : programadoPara ? 'programado' : 'nuevo'},
        ${codEntrega}, ${codRest}, ${JSON.stringify({ entrega: palabrasEntrega, restaurante: palabrasRestaurante })},
        ${latEntrega || null}, ${lngEntrega || null}, ${latEntrega || null}, ${lngEntrega || null},
        ${tiempoEstimado || null}, ${tiempoEstimadoMin || null}, ${distRestClienteKm}, ${paymentIntentId || null},
        ${tipoEntrega || 'domicilio'}, ${programadoPara || null}, ${Number(walletMonto) || 0}, ${cuponCodigo || null}
      )
      RETURNING *
    `;

    const nuevoPedido = rows[0];

    if (cuponCodigo) {
      await sql`UPDATE cupones SET usos_actual = usos_actual + 1 WHERE codigo = ${cuponCodigo}`.catch(e => logError(e, "cupones:usos"))
    }

    if (walletMonto && Number(walletMonto) > 0) {
      await sql`UPDATE usuarios SET wallet_balance = GREATEST(0, COALESCE(wallet_balance,0) - ${Number(walletMonto)}) WHERE id = ${clienteId}`.catch(e => logError(e, "wallet:debito"))
      await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto, pedido_id) VALUES (${clienteId}, 'debito', ${Number(walletMonto)}, 'Aplicado en pedido', ${nuevoPedido.id})`.catch(e => logError(e, "wallet:mov"))
    }

    // Notificar en tiempo real al propietario del restaurante cuando el pedido ya está activo ('nuevo' o 'programado')
    const ownerId = negocioRows[0].owner_id;
    if (ownerId && (nuevoPedido.status === 'nuevo' || nuevoPedido.status === 'programado')) {
      notificarCliente(ownerId, "nuevo_pedido", nuevoPedido);
      notificarCliente(ownerId, "pedido_update", nuevoPedido);
      sendPushToUser(
        sql,
        ownerId,
        "🔔 ¡Nuevo pedido recibido!",
        `Tienes un nuevo pedido por $${Number(nuevoPedido.total || 0).toFixed(2)}. Revísalo y acéptalo en la app.`,
        { pedidoId: String(nuevoPedido.id), status: nuevoPedido.status, tipo: "nuevo_pedido" }
      ).catch(e => logError(e, "push:nuevo_pedido"));
    }

    res.json(nuevoPedido);

  } catch (e: any) { res.status(500).json({ error: e.message }); }

});

// POST /api/usuario/pedidos/:id/confirmar-pago — Activa el pedido tras completarse PaymentSheet de Stripe en el cliente
router.post("/pedidos/:id/confirmar-pago", requireAuthUsuario, async (req, res) => {
  try {
    const authUserId = (req as any).usrUserId;
    const { paymentIntentId } = req.body;
    const rows = await sql`
      SELECT p.*, COALESCE(v.owner_id, v.user_id) as owner_id, v.nombre as negocio_nombre
      FROM pedidos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.id::text = ${req.params.id}
      LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ error: "Pedido no encontrado" });
    const pedido = rows[0];
    if (pedido.cliente_id !== authUserId) return res.status(403).json({ error: "No autorizado" });

    // Si ya fue activado por el webhook, devolverlo directamente
    if (pedido.status !== "pendiente_pago") {
      return res.json({ ok: true, pedido });
    }

    const piId = paymentIntentId || pedido.payment_intent_id;
    if (piId) {
      try {
        const pi = await stripeClient.paymentIntents.retrieve(piId);
        if (!["succeeded", "processing", "requires_capture"].includes(pi.status)) {
          return res.status(400).json({ error: `El pago aún no se ha completado (estado: ${pi.status}).` });
        }
      } catch (e: any) {
        logError(e, "confirmar-pago:retrieve");
      }
    }

    const nuevoStatus = pedido.programado_para ? "programado" : "nuevo";
    const [updated] = await sql`
      UPDATE pedidos
      SET status = ${nuevoStatus},
          pago_confirmado = true,
          payment_intent_id = COALESCE(${piId || null}, payment_intent_id),
          actualizado_en = NOW()
      WHERE id = ${pedido.id}
      RETURNING *
    `;

    if (pedido.owner_id) {
      notificarCliente(pedido.owner_id, "nuevo_pedido", updated);
      notificarCliente(pedido.owner_id, "pedido_update", updated);
      sendPushToUser(
        sql,
        pedido.owner_id,
        "🔔 ¡Nuevo pedido pagado con tarjeta!",
        `Tienes un nuevo pedido confirmado por $${Number(updated.total || 0).toFixed(2)} en ${pedido.negocio_nombre || "tu restaurante"}.`,
        { pedidoId: String(updated.id), status: nuevoStatus, tipo: "nuevo_pedido" }
      ).catch(() => {});
    }

    res.json({ ok: true, pedido: updated });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/usuario/pedidos/:id/borrador — Elimina borrador pendiente_pago si el usuario cancela el PaymentSheet
router.delete("/pedidos/:id/borrador", requireAuthUsuario, async (req, res) => {
  try {
    const authUserId = (req as any).usrUserId;
    const rows = await sql`
      SELECT * FROM pedidos
      WHERE id::text = ${req.params.id} AND cliente_id = ${authUserId} AND status = 'pendiente_pago'
      LIMIT 1
    `;
    if (!rows.length) return res.json({ ok: true });
    const p = rows[0];

    // Reintegrar saldo de wallet si se había descontado en el borrador
    if (p.wallet_monto && Number(p.wallet_monto) > 0) {
      await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance, 0) + ${Number(p.wallet_monto)} WHERE id = ${authUserId}`.catch(() => {});
      await sql`DELETE FROM wallet_movimientos WHERE pedido_id = ${String(p.id)}`.catch(() => {});
    }
    // Reintegrar uso de cupón si se había aplicado
    if (p.cupon_codigo) {
      await sql`UPDATE cupones SET usos_actual = GREATEST(0, COALESCE(usos_actual, 1) - 1) WHERE codigo = ${p.cupon_codigo}`.catch(() => {});
    }

    await sql`DELETE FROM pedidos WHERE id = ${p.id} AND status = 'pendiente_pago'`;
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});



router.get("/pedidos/detalle/:id", requireAuthUsuario, async (req, res) => {

  try {

    const rows = await sql`

      SELECT p.*, v.nombre as negocio_nombre, v.imagen_url as negocio_imagen, v.direccion as negocio_direccion

      FROM pedidos p LEFT JOIN viveres v ON v.id = p.negocio_id

      WHERE p.id = ${req.params.id}

    `;

    const pedido = rows[0] || null;
    if (pedido && pedido.cliente_id !== (req as any).usrUserId)
      return res.status(403).json({ error: "Acceso denegado" });

    res.json(pedido);

  } catch (e: any) { res.status(500).json({ error: e.message }); }

});



router.get("/pedidos/:userId", requireAuthUsuario, async (req, res) => {
  if ((req as any).usrUserId !== req.params.userId)
    return res.status(403).json({ error: "Acceso denegado" });

  try {
    const limit  = Math.min(Number(req.query.limit  || 20), 50)
    const offset = Number(req.query.offset || 0)

    const rows = await sql`
      SELECT p.*, v.nombre as negocio_nombre, v.imagen_url as negocio_imagen,
             r.rating as repartidor_rating, r.vehiculo as repartidor_vehiculo
      FROM pedidos p LEFT JOIN viveres v ON v.id = p.negocio_id
      LEFT JOIN repartidores r ON r.id = p.repartidor_id
      WHERE p.cliente_id = ${req.params.userId}
        AND p.status != 'pendiente_pago'
      ORDER BY p.creado_en DESC LIMIT ${limit} OFFSET ${offset}
    `;

    res.json(rows);

  } catch (e: any) { res.status(500).json({ error: e.message }); }

});



router.patch("/pedidos/confirmar", requireAuthUsuario, async (req, res) => {

  try {

    const { pedidoId, codigo } = req.body;

    const rows = await sql`SELECT codigo_entrega, status, cliente_id, repartidor_id, negocio_id FROM pedidos WHERE id = ${pedidoId}`;

    if (!rows[0]) return res.status(404).json({ error: "Pedido no encontrado" });
    if (rows[0].cliente_id !== (req as any).usrUserId) return res.status(403).json({ error: "Acceso denegado" });

    if (rows[0].codigo_entrega !== codigo) return res.status(400).json({ error: "Codigo incorrecto" });
    if (!["esperando_cliente", "en_camino", "listo"].includes(rows[0].status)) return res.status(400).json({ error: "El pedido no esta listo para confirmar entrega" });

    const [updated] = await sql`UPDATE pedidos SET status = 'entregado', entregado_en = NOW(), actualizado_en = NOW() WHERE id = ${pedidoId} RETURNING *`;
    if (rows[0].repartidor_id) {
      await sql`
        UPDATE repartidores
        SET entregas_count = COALESCE(entregas_count, 0) + 1,
            total_entregas = COALESCE(total_entregas, 0) + 1
        WHERE id = ${rows[0].repartidor_id} OR usuario_id = ${rows[0].repartidor_id}
      `.catch(() => {});
      notificarCliente(rows[0].repartidor_id, "pedido_update", updated);
    }
    if (rows[0].negocio_id) {
      const neg = await sql`SELECT COALESCE(owner_id, user_id) as owner_id FROM viveres WHERE id = ${rows[0].negocio_id}`.catch(() => []);
      if (neg[0]?.owner_id) notificarCliente(neg[0]?.owner_id, "pedido_update", updated);
    }

    res.json({ ok: true });

  } catch (e: any) { res.status(500).json({ error: e.message }); }

});

// POST /api/usuario/pedidos/:id/verificar-restaurante — Repartidor verifica palabra clave en el restaurante al recoger el pedido
router.post("/pedidos/:id/verificar-restaurante", async (req, res) => {
  try {
    const { palabra } = req.body;
    if (!palabra) return res.status(400).json({ ok: false, error: "Palabra clave requerida" });

    const rows = await sql`
      SELECT p.*, COALESCE(v.owner_id, v.user_id) as negocio_owner_id, v.nombre as negocio_nombre
      FROM pedidos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.id::text = ${req.params.id}
      LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ ok: false, error: "Pedido no encontrado" });
    const pedido = rows[0];

    if (String(pedido.codigo_restaurante || "").trim().toUpperCase() !== String(palabra).trim().toUpperCase()) {
      const nuevosIntentos = Number(pedido.intentos_codigo || 0) + 1;
      await sql`UPDATE pedidos SET intentos_codigo = ${nuevosIntentos} WHERE id = ${pedido.id}`;

      if (nuevosIntentos >= 2 && pedido.repartidor_id) {
        const repId = String(pedido.repartidor_id);
        const razon = "2 intentos fallidos de palabra clave al recolectar en restaurante";
        const [repInfo] = await sql`SELECT nombre, telefono, email FROM repartidores WHERE id = ${repId} OR usuario_id = ${repId} LIMIT 1`.catch(() => []);
        await sql`
          UPDATE repartidores
          SET bloqueado = true, razon_bloqueo = ${razon}, en_linea = false, disponible = false, status = 'offline'
          WHERE id = ${repId} OR usuario_id = ${repId}
        `.catch(() => {});
        await sql`
          INSERT INTO bloqueos_historial (tipo_usuario, actor_id, razon, bloqueado_por)
          VALUES ('repartidor', ${repId}, ${razon}, 'sistema')
        `.catch(() => {});
        // Liberar el pedido para que otro repartidor pueda tomarlo
        await sql`UPDATE pedidos SET repartidor_id = NULL, asignado_en = NULL, intentos_codigo = 0 WHERE id = ${pedido.id}`.catch(() => {});

        notificarBloqueoAdmin({
          tipoActor: "repartidor",
          actorId: repId,
          nombre: repInfo?.nombre || "Repartidor",
          telefono: repInfo?.telefono,
          email: repInfo?.email,
          razon,
          pedidoId: String(pedido.id),
        }).catch(() => {});

        return res.json({
          ok: false,
          bloqueado: true,
          intentosRestantes: 0,
          error: "Cuenta bloqueada preventivamente por 2 intentos fallidos de palabra clave. Soporte revisará tu caso.",
        });
      }

      return res.json({
        ok: false,
        bloqueado: false,
        intentosRestantes: Math.max(0, 2 - nuevosIntentos),
        error: "Palabra incorrecta. Pídele la clave correcta al restaurante (te queda 1 intento).",
      });
    }

    const [updated] = await sql`
      UPDATE pedidos
      SET verificado_restaurante = true,
          recolectado_en = NOW(),
          status = 'en_camino',
          intentos_codigo = 0,
          actualizado_en = NOW()
      WHERE id = ${pedido.id}
      RETURNING *
    `;

    const enriched = {
      ...updated,
      negocio_nombre: pedido.negocio_nombre,
    };

    if (pedido.cliente_id) {
      notificarCliente(pedido.cliente_id, "pedido_update", enriched);
      const eta = pedido.tiempo_estimado ? ` (${pedido.tiempo_estimado})` : "";
      sendPushToUser(
        sql,
        pedido.cliente_id,
        "🛵 ¡Tu pedido va en camino!",
        `El repartidor recogió tu pedido en ${pedido.negocio_nombre || "el restaurante"} y va hacia tu ubicación${eta}.`,
        { pedidoId: String(pedido.id), status: "en_camino" }
      ).catch(() => {});
    }
    if (pedido.negocio_owner_id) {
      notificarCliente(pedido.negocio_owner_id, "pedido_update", enriched);
    }
    if (pedido.repartidor_id) {
      notificarCliente(pedido.repartidor_id, "pedido_update", enriched);
    }

    res.json({ ok: true, pedido: enriched });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/usuario/pedidos/:id/verificar-entrega — Repartidor (o Restaurante en pickup) verifica palabra clave del cliente al entregar el pedido
router.post("/pedidos/:id/verificar-entrega", async (req, res) => {
  try {
    const { palabra } = req.body;
    if (!palabra) return res.status(400).json({ ok: false, error: "Palabra clave requerida" });

    const rows = await sql`
      SELECT p.*, COALESCE(v.owner_id, v.user_id) as negocio_owner_id, v.nombre as negocio_nombre
      FROM pedidos p
      LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.id::text = ${req.params.id}
      LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ ok: false, error: "Pedido no encontrado" });
    const pedido = rows[0];

    if (String(pedido.codigo_entrega || "").trim().toUpperCase() !== String(palabra).trim().toUpperCase()) {
      const nuevosIntentos = Number(pedido.intentos_codigo || 0) + 1;
      await sql`UPDATE pedidos SET intentos_codigo = ${nuevosIntentos} WHERE id = ${pedido.id}`;

      if (nuevosIntentos >= 2 && pedido.repartidor_id) {
        const repId = String(pedido.repartidor_id);
        const razon = "2 intentos fallidos de palabra clave al entregar al cliente";
        const [repInfo] = await sql`SELECT nombre, telefono, email FROM repartidores WHERE id = ${repId} OR usuario_id = ${repId} LIMIT 1`.catch(() => []);
        await sql`
          UPDATE repartidores
          SET bloqueado = true, razon_bloqueo = ${razon}, en_linea = false, disponible = false, status = 'offline'
          WHERE id = ${repId} OR usuario_id = ${repId}
        `.catch(() => {});
        await sql`
          INSERT INTO bloqueos_historial (tipo_usuario, actor_id, razon, bloqueado_por)
          VALUES ('repartidor', ${repId}, ${razon}, 'sistema')
        `.catch(() => {});

        notificarBloqueoAdmin({
          tipoActor: "repartidor",
          actorId: repId,
          nombre: repInfo?.nombre || "Repartidor",
          telefono: repInfo?.telefono,
          email: repInfo?.email,
          razon,
          pedidoId: String(pedido.id),
        }).catch(() => {});

        return res.json({
          ok: false,
          bloqueado: true,
          intentosRestantes: 0,
          error: "Cuenta bloqueada preventivamente por 2 intentos fallidos de palabra clave. Soporte revisará tu caso.",
        });
      }

      return res.json({
        ok: false,
        bloqueado: false,
        intentosRestantes: Math.max(0, 2 - nuevosIntentos),
        error: "Palabra incorrecta. Verifica la clave con el cliente (te queda 1 intento).",
      });
    }

    const [updated] = await sql`
      UPDATE pedidos
      SET status = 'entregado',
          entregado_en = NOW(),
          intentos_codigo = 0,
          actualizado_en = NOW()
      WHERE id = ${pedido.id}
      RETURNING *
    `;

    if (pedido.repartidor_id) {
      try {
        await sql`
          UPDATE repartidores
          SET entregas_count = COALESCE(entregas_count, 0) + 1,
              total_entregas = COALESCE(total_entregas, 0) + 1
          WHERE id = ${pedido.repartidor_id} OR usuario_id = ${pedido.repartidor_id}
        `;
      } catch (e: any) {
        logError(e, "verificar-entrega:repartidor");
      }
      notificarCliente(pedido.repartidor_id, "pedido_update", updated);
    }

    if (pedido.cliente_id) {
      notificarCliente(pedido.cliente_id, "pedido_update", updated);
      sendPushToUser(
        sql,
        pedido.cliente_id,
        "🎉 ¡Pedido entregado!",
        "¡Que lo disfrutes! No olvides calificar tu experiencia.",
        { pedidoId: String(pedido.id), status: "entregado" }
      ).catch(() => {});
    }
    if (pedido.negocio_owner_id) {
      notificarCliente(pedido.negocio_owner_id, "pedido_update", updated);
      sendPushToUser(
        sql,
        pedido.negocio_owner_id,
        "✅ Pedido entregado al cliente",
        `El pedido #${String(pedido.id).slice(-5).toUpperCase()} fue entregado con código verificado.`,
        { pedidoId: String(pedido.id), status: "entregado" }
      ).catch(() => {});
    }

    res.json({ ok: true, pedido: updated });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});



router.patch("/pedidos/:id/cancelar", requireAuthUsuario, async (req, res) => {

  try {

    const rows = await sql`SELECT status, repartidor_id, cliente_id, negocio_id FROM pedidos WHERE id = ${req.params.id}`;

    if (!rows.length) return res.status(404).json({ error: "Pedido no encontrado" });
    if (rows[0].cliente_id !== (req as any).usrUserId) return res.status(403).json({ error: "Acceso denegado" });

    const { status } = rows[0];

    if (!["nuevo", "preparando"].includes(status))

      return res.status(400).json({ error: "No se puede cancelar en este punto" });

    const [updated] = await sql`UPDATE pedidos SET status = 'cancelado', cancelado_en = NOW(), razon_cancelacion = 'Cancelado por el cliente' WHERE id = ${req.params.id} RETURNING *`;

    if (rows[0].repartidor_id) {
      notificarCliente(rows[0].repartidor_id, "pedido_update", updated);
      await sendPushToUser(sql, rows[0].repartidor_id, "Pedido cancelado", "El usuario canceló el pedido", { tipo: "pedido_cancelado", pedido_id: req.params.id }).catch(() => {})
    }
    if (rows[0].negocio_id) {
      const neg = await sql`SELECT COALESCE(owner_id, user_id) as owner_id FROM viveres WHERE id = ${rows[0].negocio_id}`.catch(() => []);
      if (neg[0]?.owner_id) {
        notificarCliente(neg[0].owner_id, "pedido_update", updated);
        await sendPushToUser(sql, neg[0].owner_id, "❌ Pedido cancelado por el cliente", "El cliente canceló su pedido.", { pedidoId: req.params.id, status: "cancelado" }).catch(() => {})
      }
    }
    res.json({ ok: true });

  } catch (e: any) { res.status(500).json({ error: e.message }); }

});



router.patch("/pedidos/:id/rating", requireAuthUsuario, async (req, res) => {
  try {
    const { rating_restaurante, rating_repartidor, aspectos_restaurante, aspectos_repartidor } = req.body;

    const validarRating = (r: any) => r == null || (Number.isInteger(Number(r)) && Number(r) >= 1 && Number(r) <= 5);
    if (!validarRating(rating_restaurante)) return res.status(400).json({ error: "rating_restaurante debe ser entre 1 y 5" });
    if (!validarRating(rating_repartidor)) return res.status(400).json({ error: "rating_repartidor debe ser entre 1 y 5" });

    const aspRestJson = JSON.stringify(Array.isArray(aspectos_restaurante) ? aspectos_restaurante : []);
    const aspRepJson = JSON.stringify(Array.isArray(aspectos_repartidor) ? aspectos_repartidor : []);

    await sql`
      UPDATE pedidos SET 
        rating_restaurante = ${rating_restaurante ?? null}, 
        rating_repartidor = ${rating_repartidor ?? null}, 
        aspectos_restaurante = ${aspRestJson}::jsonb,
        aspectos_repartidor = ${aspRepJson}::jsonb
      WHERE id = ${req.params.id}
    `;

    if (rating_restaurante) {
      await sql`
        UPDATE viveres 
        SET rating = ROUND((SELECT COALESCE(AVG(rating_restaurante), 0.0) FROM pedidos WHERE negocio_id = (SELECT negocio_id FROM pedidos WHERE id = ${req.params.id}) AND rating_restaurante IS NOT NULL), 1) 
        WHERE id = (SELECT negocio_id FROM pedidos WHERE id = ${req.params.id})
      `;
    }

    if (rating_repartidor) {
      await sql`
        UPDATE repartidores 
        SET rating = ROUND((SELECT COALESCE(AVG(rating_repartidor), 0.0) FROM pedidos WHERE repartidor_id = (SELECT repartidor_id FROM pedidos WHERE id = ${req.params.id}) AND rating_repartidor IS NOT NULL), 1),
            entregas_count = (SELECT COUNT(*) FROM pedidos WHERE repartidor_id = (SELECT repartidor_id FROM pedidos WHERE id = ${req.params.id}) AND status = 'entregado') 
        WHERE id = (SELECT repartidor_id FROM pedidos WHERE id = ${req.params.id})
      `;
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/usuario/pedidos/:id/rating-cliente — el repartidor califica al cliente


// POST /api/usuario/pedidos/:id/propina
router.post("/pedidos/:id/propina", requireAuthUsuario, async (req: any, res: any) => {
  try {
    const { monto } = req.body;
    const propinaNum = Number(monto);
    if (!propinaNum || propinaNum <= 0) {
      return res.status(400).json({ error: "Monto de propina inválido" });
    }

    const [pedido] = await sql`
      SELECT id, cliente_id, repartidor_id, status FROM pedidos WHERE id = ${req.params.id}
    `;
    if (!pedido) return res.status(404).json({ error: "Pedido no encontrado" });
    if (!pedido.repartidor_id) return res.status(400).json({ error: "El pedido no tiene repartidor asignado" });

    await sql.begin(async (tx: any) => {
      await tx`
        UPDATE pedidos SET propina = COALESCE(propina, 0) + ${propinaNum} WHERE id = ${pedido.id}
      `;
      await tx`
        UPDATE repartidores SET saldo = COALESCE(saldo, 0) + ${propinaNum} WHERE id = ${pedido.repartidor_id}
      `;
    });

    try {
      const { sendPushToUser } = await import("../firebase");
      await sendPushToUser(
        sql,
        pedido.repartidor_id,
        "🎉 ¡Recibiste una propina!",
        `El cliente te ha dejado una propina de ${propinaNum.toFixed(2)} MXN por tu excelente servicio.`,
        { pedidoId: pedido.id, tipo: "propina", monto: String(propinaNum) }
      );
    } catch {}

    res.json({ ok: true, propina: propinaNum });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/pedidos/:id/rating-cliente", async (req, res) => {
  try {
    const { rating_cliente, aspectos_cliente } = req.body;
    const validarRating = (r: any) => r == null || (Number.isInteger(Number(r)) && Number(r) >= 1 && Number(r) <= 5);
    if (!validarRating(rating_cliente)) return res.status(400).json({ error: "rating_cliente debe ser entre 1 y 5" });

    const aspCliJson = JSON.stringify(Array.isArray(aspectos_cliente) ? aspectos_cliente : []);
    await sql`
      UPDATE pedidos SET 
        rating_cliente = ${rating_cliente ?? null}, 
        aspectos_cliente = ${aspCliJson}::jsonb 
      WHERE id = ${req.params.id}
    `;

    if (rating_cliente) {
      await sql`
        UPDATE usuarios 
        SET rating = ROUND((SELECT COALESCE(AVG(rating_cliente), 0.0) FROM pedidos WHERE cliente_id = (SELECT cliente_id FROM pedidos WHERE id = ${req.params.id}) AND rating_cliente IS NOT NULL), 1)
        WHERE id = (SELECT cliente_id FROM pedidos WHERE id = ${req.params.id})
      `;
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/usuario/perfil/:userId/calificaciones-aspectos — desglose de aspectos del cliente
router.get("/perfil/:userId/calificaciones-aspectos", async (req, res) => {
  try {
    const [usr] = await sql`SELECT rating FROM usuarios WHERE id = ${req.params.userId}`;
    const pedidosRows = await sql`
      SELECT rating_cliente, aspectos_cliente 
      FROM pedidos 
      WHERE cliente_id = ${req.params.userId} AND rating_cliente IS NOT NULL
      ORDER BY creado_en DESC LIMIT 100
    `;
    const ratingPromedio = usr?.rating ? Number(Number(usr.rating).toFixed(1)) : 0.0;
    const aspectosConteo: Record<string, number> = {
      "Puntualidad al recibir": 0,
      "Instrucciones claras": 0,
      "Amabilidad y respeto": 0,
    };
    let totalRatings = pedidosRows.length;
    for (const p of pedidosRows) {
      const asp = Array.isArray(p.aspectos_cliente) ? p.aspectos_cliente : (typeof p.aspectos_cliente === 'string' ? JSON.parse(p.aspectos_cliente) : []);
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



// GET /api/usuario/perfil/:userId
router.get("/perfil/:userId", async (req, res) => {
  try {
    const rows = await sql`SELECT id, nombre, email, telefono, foto_perfil, foto_url FROM usuarios WHERE id = ${req.params.userId}`
    res.json(rows[0] || {})
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PATCH /api/usuario/perfil/:userId
router.patch("/perfil/:userId", requireAuthUsuario, async (req, res) => {
  if ((req as any).usrUserId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const { nombre, telefono, foto_perfil } = req.body
    await sql`
      UPDATE usuarios SET 
        nombre = COALESCE(NULLIF(${nombre}, ''), nombre),
        telefono = ${telefono !== undefined ? telefono : null},
        foto_perfil = COALESCE(${foto_perfil}, foto_perfil)
      WHERE id = ${req.params.userId}
    `
    const [updated] = await sql`SELECT id, nombre, email, telefono, foto_perfil, foto_url FROM usuarios WHERE id = ${req.params.userId}`
    res.json({ ok: true, usuario: updated })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/usuario/:userId — eliminar cuenta por completo y liberar todo el almacenamiento (BD, Storage y Auth)
router.delete("/:userId", requireAuth, async (req, res) => {
  const authId = (req as any).userId
  if (authId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const { userId } = req.params
    const activos = await sql`SELECT id FROM pedidos WHERE cliente_id = ${userId} AND status NOT IN ('entregado','cancelado','pago_fallido') LIMIT 1`
    if (activos.length) return res.status(400).json({ error: "Tienes pedidos activos. Espera a que finalicen antes de eliminar tu cuenta." })

    const activosRepartidor = await sql`SELECT id FROM pedidos WHERE repartidor_id = ${userId} AND status NOT IN ('entregado','cancelado','pago_fallido') LIMIT 1`.catch(() => [])
    if (activosRepartidor.length) return res.status(400).json({ error: "Tienes entregas activas en curso. Finalízalas antes de eliminar tu cuenta." })

    // 1. Eliminar fotos y archivos del usuario en Supabase Storage para no gastar almacenamiento
    const [usrRow] = await sql`SELECT foto_url, foto_perfil FROM usuarios WHERE id = ${userId}`.catch(() => [])
    if (usrRow?.foto_url) await deleteSupabaseStorageFile(usrRow.foto_url).catch(() => {})
    if (usrRow?.foto_perfil && usrRow.foto_perfil !== usrRow.foto_url) await deleteSupabaseStorageFile(usrRow.foto_perfil).catch(() => {})

    const solicitudesRows = await sql`SELECT documentos FROM solicitudes WHERE usuario_id = ${userId}`.catch(() => [])
    for (const sol of solicitudesRows) {
      const docs = sol.documentos || {}
      for (const val of Object.values(docs)) {
        if (typeof val === "string" && val.startsWith("http")) {
          await deleteSupabaseStorageFile(val).catch(() => {})
        }
      }
    }

    // 2. Eliminar todos los registros asociados del usuario en nuestras tablas
    await sql`DELETE FROM device_tokens WHERE user_id = ${userId}`.catch(() => {})
    await sql`DELETE FROM direcciones WHERE usuario_id = ${userId}`.catch(() => {})
    await sql`DELETE FROM favoritos WHERE usuario_id = ${userId} OR cliente_id = ${userId}`.catch(() => {})
    await sql`DELETE FROM notificaciones WHERE user_id = ${userId}`.catch(() => {})
    await sql`DELETE FROM wallet_movimientos WHERE usuario_id = ${userId}`.catch(() => {})
    await sql`DELETE FROM puntos_movimientos WHERE usuario_id = ${userId}`.catch(() => {})
    await sql`DELETE FROM referidos WHERE referidor_id = ${userId} OR referido_id = ${userId}`.catch(() => {})
    await sql`DELETE FROM mensajes WHERE emisor_id = ${userId} OR remitente_id = ${userId}`.catch(() => {})
    await sql`DELETE FROM solicitudes WHERE usuario_id = ${userId}`.catch(() => {})
    await sql`DELETE FROM repartidores WHERE id = ${userId} OR usuario_id = ${userId} OR user_id = ${userId}`.catch(() => {})

    // 3. Anonimizar pedidos históricos concluidos para conservar contabilidad del restaurante/repartidor sin datos personales del cliente
    await sql`UPDATE pedidos SET cliente_id = 'cuenta_eliminada', direccion_entrega = '', notas = '' WHERE cliente_id = ${userId}`.catch(() => {})

    // 4. Eliminar definitivamente la fila de la tabla usuarios y la cuenta en Supabase Auth
    await sql`DELETE FROM usuarios WHERE id = ${userId}`.catch(() => {})
    await supabase.auth.admin.deleteUser(userId).catch(() => {})

    res.json({ ok: true, deleted: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ── Direcciones ──────────────────────────────────────────────────────────────

// ── Direcciones ──────────────────────────────────────────────────────────────

// GET /api/usuario/direcciones/:userId
router.get("/direcciones/:userId", requireAuth, async (req, res) => {
  const authUserId = (req as any).userId
  if (authUserId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const rows = await sql`SELECT * FROM direcciones WHERE usuario_id = ${req.params.userId} ORDER BY principal DESC, creado_en ASC`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/usuario/direcciones  { label, icono, direccion, lat, lng }
router.post("/direcciones", requireAuth, async (req, res) => {
  const authUserId = (req as any).userId
  try {
    const { label, icono, direccion, lat, lng, principal } = req.body
    if (!label || !direccion) return res.status(400).json({ error: "label y direccion requeridos" })
    const existe = await sql`SELECT id FROM direcciones WHERE usuario_id = ${authUserId} LIMIT 1`
    const esPrimera = existe.length === 0
    const esPrincipal = principal !== undefined ? Boolean(principal) : esPrimera
    if (esPrincipal) await sql`UPDATE direcciones SET principal = false WHERE usuario_id = ${authUserId}`
    const rows = await sql`
      INSERT INTO direcciones (usuario_id, label, icono, direccion, lat, lng, principal)
      VALUES (${authUserId}, ${label}, ${icono || 'otro'}, ${direccion}, ${lat || null}, ${lng || null}, ${esPrincipal})
      RETURNING *`
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PUT /api/usuario/direcciones/:id
router.put("/direcciones/:id", requireAuth, async (req, res) => {
  const authUserId = (req as any).userId
  try {
    const { label, icono, direccion, lat, lng } = req.body
    const rows = await sql`
      UPDATE direcciones SET label = ${label}, icono = ${icono}, direccion = ${direccion}, lat = ${lat || null}, lng = ${lng || null}
      WHERE id = ${req.params.id} AND usuario_id = ${authUserId} RETURNING *`
    if (!rows.length) return res.status(404).json({ error: "Dirección no encontrada" })
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PATCH /api/usuario/direcciones/:id/principal
router.patch("/direcciones/:id/principal", requireAuth, async (req, res) => {
  const authUserId = (req as any).userId
  try {
    await sql`UPDATE direcciones SET principal = false WHERE usuario_id = ${authUserId}`
    const rows = await sql`UPDATE direcciones SET principal = true WHERE id = ${req.params.id} AND usuario_id = ${authUserId} RETURNING *`
    if (!rows.length) return res.status(404).json({ error: "Dirección no encontrada" })
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/usuario/direcciones/:id
router.delete("/direcciones/:id", requireAuth, async (req, res) => {
  const authUserId = (req as any).userId
  try {
    const rows = await sql`DELETE FROM direcciones WHERE id = ${req.params.id} AND usuario_id = ${authUserId} RETURNING usuario_id, principal`
    if (!rows.length) return res.status(404).json({ error: "Dirección no encontrada" })
    if (rows[0].principal) {
      await sql`
        UPDATE direcciones
        SET principal = true
        WHERE id = (
          SELECT id FROM direcciones
          WHERE usuario_id = ${authUserId}
          ORDER BY creado_en ASC
          LIMIT 1
        )
      `.catch(() => {})
    }
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ── Favoritos ─────────────────────────────────────────────────────────────────

// GET /api/usuario/favoritos/:clienteId
router.get("/favoritos/:clienteId", requireAuth, async (req, res) => {
  const authUserId = (req as any).userId
  if (authUserId !== req.params.clienteId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const rows = await sql`
      SELECT v.* FROM favoritos f
      JOIN viveres v ON v.id::text = f.negocio_id
      WHERE f.cliente_id = ${req.params.clienteId}
      ORDER BY f.creado_en DESC`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/usuario/favoritos  { negocioId }
router.post("/favoritos", requireAuth, async (req, res) => {
  const authUserId = (req as any).userId
  try {
    const { negocioId } = req.body
    if (!negocioId) return res.status(400).json({ error: "negocioId requerido" })
    await sql`INSERT INTO favoritos (cliente_id, negocio_id) VALUES (${authUserId}, ${negocioId}) ON CONFLICT DO NOTHING`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/usuario/favoritos/:clienteId/:negocioId
router.delete("/favoritos/:clienteId/:negocioId", requireAuth, async (req, res) => {
  const authUserId = (req as any).userId
  if (authUserId !== req.params.clienteId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    await sql`DELETE FROM favoritos WHERE cliente_id = ${authUserId} AND negocio_id = ${req.params.negocioId}`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router;


