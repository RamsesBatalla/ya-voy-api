import { Router } from "express";
import rateLimit from "express-rate-limit";
import { sql } from "../db";
import { sendPushToUser } from "../firebase";
import { requireAuth, requireAuthUsuario } from "../middleware/auth";
import { getAuth } from "@clerk/express";
import { getCache, setCache, invalidateCache } from "../cache";
import { logError } from "../logger";

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

  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS costo_envio NUMERIC DEFAULT 35`

  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tiempo_estimado TEXT`

}

initTablas().catch(e => console.error("Error init tablas:", e.message))



router.get("/productos/feed", async (_req, res) => {

  try {

    const rows = await sql`

      SELECT p.*, v.nombre as negocio_nombre, v.id as negocio_id,

             v.imagen_url as negocio_imagen, v.rating as negocio_rating

      FROM productos p

      JOIN viveres v ON v.id::text = p.negocio_id

      WHERE p.disponible = true AND v.status = 'aprobado' AND v.esta_abierto = true

      ORDER BY p.destacado DESC, v.rating DESC NULLS LAST, p.nombre

      LIMIT 80

    `;

    res.json(rows);

  } catch (e: any) { res.status(500).json({ error: e.message }); }

});



router.get("/negocios", async (req, res) => {

  try {

    const q = ((req.query.q as string) || "").trim()

    if (q.length >= 2) {
      const rows = await sql`
        SELECT * FROM viveres
        WHERE status = 'aprobado'
          AND esta_abierto = true
          AND (nombre % ${q} OR nombre ILIKE ${'%' + q + '%'})
        ORDER BY similarity(nombre, ${q}) DESC, rating DESC
        LIMIT 50`
      return res.json(rows)
    }

    const cached = getCache<any[]>("negocios:all")
    if (cached) return res.json(cached)

    const rows = await sql`SELECT * FROM viveres WHERE status = 'aprobado' AND esta_abierto = true ORDER BY aceptando_pedidos DESC NULLS LAST, rating DESC`
    setCache("negocios:all", rows)
    res.json(rows);

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

    const { userId: authUserId } = getAuth(req);
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

    const envio = costoEnvio ?? 35;
    let subtotalCalculado = 0
    for (const item of items) {
      const precioBase = precioMap[item.productoId] ?? Number(item.precioBase ?? item.precio ?? 0)
      const extras = (item.opciones || []).reduce((s: number, o: any) => s + Number(o.precio || 0), 0)
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

    const negocioRows = await sql`SELECT esta_abierto, aceptando_pedidos, horarios FROM viveres WHERE id = ${negocioId}`
    if (!negocioRows.length || !negocioRows[0].esta_abierto) return res.status(400).json({ error: "Este restaurante está cerrado en este momento." })
    if (negocioRows[0].aceptando_pedidos === false) return res.status(400).json({ error: "Este restaurante pausó temporalmente los pedidos. Intenta en unos minutos." })
    const horarios = negocioRows[0].horarios
    if (horarios) {
      const DIAS_MAP = ['Dom','Lun','Mar','Mie','Jue','Vie','Sab']
      const now = new Date()
      const diaKey = DIAS_MAP[now.getDay()]
      const diaHorario = horarios[diaKey]
      if (diaHorario && !diaHorario.abierto) return res.status(400).json({ error: "Este restaurante no atiende hoy." })
      if (diaHorario?.desde && diaHorario?.hasta) {
        const [hDesde, mDesde] = diaHorario.desde.split(':').map(Number)
        const [hHasta, mHasta] = diaHorario.hasta.split(':').map(Number)
        const minActual = now.getHours() * 60 + now.getMinutes()
        const minDesde = hDesde * 60 + mDesde
        const minHasta = hHasta * 60 + mHasta
        if (minActual < minDesde || minActual > minHasta)
          return res.status(400).json({ error: `Este restaurante atiende de ${diaHorario.desde} a ${diaHorario.hasta}.` })
      }
    }

    const cfgLimite = await sql`SELECT valor FROM app_config WHERE clave = 'max_pedidos_simultaneos'`
    const maxPedidos = cfgLimite.length ? parseInt(cfgLimite[0].valor) : 10
    const pedidosRest = await sql`SELECT COUNT(*) as cnt FROM pedidos WHERE negocio_id = ${negocioId} AND status NOT IN ('entregado','cancelado')`
    if (parseInt(pedidosRest[0].cnt) >= maxPedidos) return res.status(429).json({ error: "Este restaurante tiene demasiados pedidos activos en este momento. Intenta en unos minutos." })

    const rows = await sql`

      INSERT INTO pedidos (cliente_id, negocio_id, items, total, costo_envio, propina, direccion_entrega, notas, metodo_pago, status, codigo_entrega, codigo_restaurante, palabras_verificacion, lat_entrega, lng_entrega, tiempo_estimado, tiempo_estimado_min, payment_intent_id, tipo_entrega, programado_para)

VALUES (${clienteId}, ${negocioId}, ${JSON.stringify(items)}, ${totalCalculado}, ${tipoEntrega === 'pickup' ? 0 : envio}, ${Number(propina) || 0}, ${direccionEntrega || ''}, ${notas || ''}, ${metodoPago || 'efectivo'}, ${statusInicial === 'pendiente_pago' ? 'pendiente_pago' : programadoPara ? 'programado' : 'nuevo'}, ${codEntrega}, ${codRest}, ${JSON.stringify({ entrega: palabrasEntrega, restaurante: palabrasRestaurante })}, ${latEntrega || null}, ${lngEntrega || null}, ${tiempoEstimado || null}, ${tiempoEstimadoMin || null}, ${paymentIntentId || null}, ${tipoEntrega || 'domicilio'}, ${programadoPara || null})

      RETURNING *

    `;

    if (cuponCodigo) {
      await sql`UPDATE cupones SET usos_actual = usos_actual + 1 WHERE codigo = ${cuponCodigo}`.catch(e => logError(e, "cupones:usos"))
    }

    if (walletMonto && Number(walletMonto) > 0) {
      await sql`UPDATE usuarios SET wallet_balance = GREATEST(0, COALESCE(wallet_balance,0) - ${Number(walletMonto)}) WHERE id = ${clienteId}`.catch(e => logError(e, "wallet:debito"))
      await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto, pedido_id) VALUES (${clienteId}, 'debito', ${Number(walletMonto)}, 'Aplicado en pedido', ${rows[0].id})`.catch(e => logError(e, "wallet:mov"))
    }

    res.json(rows[0]);

  } catch (e: any) { res.status(500).json({ error: e.message }); }

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
      ORDER BY p.creado_en DESC LIMIT ${limit} OFFSET ${offset}
    `;

    res.json(rows);

  } catch (e: any) { res.status(500).json({ error: e.message }); }

});



router.patch("/pedidos/confirmar", requireAuthUsuario, async (req, res) => {

  try {

    const { pedidoId, codigo } = req.body;

    const rows = await sql`SELECT codigo_entrega, status, cliente_id FROM pedidos WHERE id = ${pedidoId}`;

    if (!rows[0]) return res.status(404).json({ error: "Pedido no encontrado" });
    if (rows[0].cliente_id !== (req as any).usrUserId) return res.status(403).json({ error: "Acceso denegado" });

    if (rows[0].codigo_entrega !== codigo) return res.status(400).json({ error: "Codigo incorrecto" });
    if (!["esperando_cliente", "en_camino"].includes(rows[0].status)) return res.status(400).json({ error: "El pedido no esta listo para confirmar entrega" });

    await sql`UPDATE pedidos SET status = 'entregado' WHERE id = ${pedidoId}`;

    res.json({ ok: true });

  } catch (e: any) { res.status(500).json({ error: e.message }); }

});



router.patch("/pedidos/:id/cancelar", requireAuthUsuario, async (req, res) => {

  try {

    const rows = await sql`SELECT status, repartidor_id, cliente_id FROM pedidos WHERE id = ${req.params.id}`;

    if (!rows.length) return res.status(404).json({ error: "Pedido no encontrado" });
    if (rows[0].cliente_id !== (req as any).usrUserId) return res.status(403).json({ error: "Acceso denegado" });

    const { status } = rows[0];

    if (!["nuevo", "preparando"].includes(status))

      return res.status(400).json({ error: "No se puede cancelar en este punto" });

    await sql`UPDATE pedidos SET status = 'cancelado', cancelado_en = NOW() WHERE id = ${req.params.id}`;

    if (rows[0].repartidor_id) {
      await sendPushToUser(sql, rows[0].repartidor_id, "Pedido cancelado", "El usuario cancelo el pedido", { tipo: "pedido_cancelado", pedido_id: req.params.id }).catch(() => {})
    }
    res.json({ ok: true });

  } catch (e: any) { res.status(500).json({ error: e.message }); }

});



router.patch("/pedidos/:id/rating", requireAuthUsuario, async (req, res) => {

  try {

    const { rating_restaurante, rating_repartidor, comentario_rating } = req.body;

    const validarRating = (r: any) => r == null || (Number.isInteger(Number(r)) && Number(r) >= 1 && Number(r) <= 5)
    if (!validarRating(rating_restaurante)) return res.status(400).json({ error: "rating_restaurante debe ser entre 1 y 5" })
    if (!validarRating(rating_repartidor)) return res.status(400).json({ error: "rating_repartidor debe ser entre 1 y 5" })

    await sql`UPDATE pedidos SET rating_restaurante = ${rating_restaurante ?? null}, rating_repartidor = ${rating_repartidor ?? null}, comentario_rating = ${comentario_rating || ''} WHERE id = ${req.params.id}`;

    if (rating_restaurante) {

      await sql`UPDATE viveres SET rating = (SELECT AVG(rating_restaurante) FROM pedidos WHERE negocio_id = (SELECT negocio_id FROM pedidos WHERE id = ${req.params.id}) AND rating_restaurante IS NOT NULL) WHERE id = (SELECT negocio_id FROM pedidos WHERE id = ${req.params.id})`;

    }

    if (rating_repartidor) {
      await sql`UPDATE repartidores SET rating = (SELECT AVG(rating_repartidor) FROM pedidos WHERE repartidor_id = (SELECT repartidor_id FROM pedidos WHERE id = ${req.params.id}) AND rating_repartidor IS NOT NULL), entregas_count = (SELECT COUNT(*) FROM pedidos WHERE repartidor_id = (SELECT repartidor_id FROM pedidos WHERE id = ${req.params.id}) AND status = 'entregado') WHERE id = (SELECT repartidor_id FROM pedidos WHERE id = ${req.params.id})`
    }
    res.json({ ok: true });

  } catch (e: any) { res.status(500).json({ error: e.message }); }

});



// GET /api/usuario/perfil/:userId
router.get("/perfil/:userId", async (req, res) => {
  try {
    const rows = await sql`SELECT foto_perfil FROM usuarios WHERE id = ${req.params.userId}`
    res.json(rows[0] || {})
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PATCH /api/usuario/perfil/:userId
router.patch("/perfil/:userId", requireAuthUsuario, async (req, res) => {
  if ((req as any).usrUserId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const { foto_perfil } = req.body
    await sql`UPDATE usuarios SET foto_perfil = ${foto_perfil} WHERE id = ${req.params.userId}`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/usuario/:userId — eliminar cuenta (soft delete, solo el propio usuario)
router.delete("/:userId", requireAuth, async (req, res) => {
  const { userId: authId } = getAuth(req)
  if (authId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const { userId } = req.params
    const activos = await sql`SELECT id FROM pedidos WHERE cliente_id = ${userId} AND status NOT IN ('entregado','cancelado','pago_fallido') LIMIT 1`
    if (activos.length) return res.status(400).json({ error: "Tienes pedidos activos. Espera a que finalicen antes de eliminar tu cuenta." })
    await sql`DELETE FROM device_tokens WHERE user_id = ${userId}`
    await sql`UPDATE usuarios SET eliminado_en = NOW(), email = '', nombre = 'Cuenta eliminada', foto_url = NULL WHERE id = ${userId}`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ── Direcciones ──────────────────────────────────────────────────────────────

// ── Direcciones ──────────────────────────────────────────────────────────────

// GET /api/usuario/direcciones/:userId
router.get("/direcciones/:userId", requireAuth, async (req, res) => {
  const { userId: authUserId } = getAuth(req)
  if (authUserId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const rows = await sql`SELECT * FROM direcciones WHERE usuario_id = ${req.params.userId} ORDER BY principal DESC, creado_en ASC`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/usuario/direcciones  { label, icono, direccion, lat, lng }
router.post("/direcciones", requireAuth, async (req, res) => {
  const { userId: authUserId } = getAuth(req)
  try {
    const { label, icono, direccion, lat, lng } = req.body
    if (!label || !direccion) return res.status(400).json({ error: "label y direccion requeridos" })
    const existe = await sql`SELECT id FROM direcciones WHERE usuario_id = ${authUserId} LIMIT 1`
    const esPrimera = existe.length === 0
    if (!esPrimera) await sql`UPDATE direcciones SET principal = false WHERE usuario_id = ${authUserId}`
    const rows = await sql`
      INSERT INTO direcciones (usuario_id, label, icono, direccion, lat, lng, principal)
      VALUES (${authUserId}, ${label}, ${icono || 'otro'}, ${direccion}, ${lat || null}, ${lng || null}, ${esPrimera})
      RETURNING *`
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PUT /api/usuario/direcciones/:id
router.put("/direcciones/:id", requireAuth, async (req, res) => {
  const { userId: authUserId } = getAuth(req)
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
  const { userId: authUserId } = getAuth(req)
  try {
    await sql`UPDATE direcciones SET principal = false WHERE usuario_id = ${authUserId}`
    const rows = await sql`UPDATE direcciones SET principal = true WHERE id = ${req.params.id} AND usuario_id = ${authUserId} RETURNING *`
    if (!rows.length) return res.status(404).json({ error: "Dirección no encontrada" })
    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/usuario/direcciones/:id
router.delete("/direcciones/:id", requireAuth, async (req, res) => {
  const { userId: authUserId } = getAuth(req)
  try {
    const rows = await sql`DELETE FROM direcciones WHERE id = ${req.params.id} AND usuario_id = ${authUserId} RETURNING usuario_id, principal`
    if (!rows.length) return res.status(404).json({ error: "Dirección no encontrada" })
    if (rows[0].principal) {
      await sql`UPDATE direcciones SET principal = true WHERE usuario_id = ${authUserId} ORDER BY creado_en ASC LIMIT 1`
    }
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ── Favoritos ─────────────────────────────────────────────────────────────────

// GET /api/usuario/favoritos/:clienteId
router.get("/favoritos/:clienteId", requireAuth, async (req, res) => {
  const { userId: authUserId } = getAuth(req)
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
  const { userId: authUserId } = getAuth(req)
  try {
    const { negocioId } = req.body
    if (!negocioId) return res.status(400).json({ error: "negocioId requerido" })
    await sql`INSERT INTO favoritos (cliente_id, negocio_id) VALUES (${authUserId}, ${negocioId}) ON CONFLICT DO NOTHING`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/usuario/favoritos/:clienteId/:negocioId
router.delete("/favoritos/:clienteId/:negocioId", requireAuth, async (req, res) => {
  const { userId: authUserId } = getAuth(req)
  if (authUserId !== req.params.clienteId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    await sql`DELETE FROM favoritos WHERE cliente_id = ${authUserId} AND negocio_id = ${req.params.negocioId}`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router;


