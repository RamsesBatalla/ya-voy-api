import { Router } from "express";
import { sql } from "../db";

const router = Router();

const initTablas = async () => {
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

router.get("/negocios", async (_req, res) => {
  try {
    const rows = await sql`SELECT * FROM viveres WHERE status = 'aprobado' AND esta_abierto = true ORDER BY rating DESC`;
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/negocios/:id", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM viveres WHERE id = ${req.params.id}`;
    res.json(rows[0] || null);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/negocios/:id/productos", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM productos WHERE negocio_id = ${req.params.id} AND disponible = true ORDER BY destacado DESC, categoria, nombre`;
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

router.post("/cupones/validar", async (req, res) => {
  try {
    const { codigo, total } = req.body
    if (!codigo) return res.status(400).json({ error: "Codigo requerido" })
    const rows = await sql`SELECT * FROM cupones WHERE codigo = ${codigo.toUpperCase().trim()} AND activo = true`
    if (!rows.length) return res.status(404).json({ error: "Cupon invalido o no existe" })
    const cupon = rows[0]
    if (cupon.expira_en && new Date(cupon.expira_en) < new Date())
      return res.status(400).json({ error: "Este cupon ha expirado" })
    if (cupon.usos_max && cupon.usos_actual >= cupon.usos_max)
      return res.status(400).json({ error: "Este cupon ya no tiene usos disponibles" })
    const descuento = cupon.tipo === "porcentaje"
      ? Math.min(Number(total) * Number(cupon.valor) / 100, Number(total))
      : Math.min(Number(cupon.valor), Number(total))
    res.json({ valido: true, descuento: Number(descuento.toFixed(2)), tipo: cupon.tipo, valor: Number(cupon.valor), codigo: cupon.codigo })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post("/pedidos", async (req, res) => {
  try {
    const { clienteId, negocioId, items, total, direccionEntrega, notas, metodoPago, latEntrega, lngEntrega, cuponCodigo, descuentoCupon, costoEnvio, tiempoEstimado } = req.body;
    await sql`INSERT INTO usuarios (id, email, nombre, rol) VALUES (${clienteId}, '', '', 'cliente') ON CONFLICT (id) DO NOTHING`;
    const [codEntrega, codRest] = genDos();
    const palabrasEntrega = genTres(codEntrega);
    const palabrasRestaurante = genTres(codRest);
    const envio = costoEnvio ?? 35;
    const rows = await sql`
      INSERT INTO pedidos (cliente_id, negocio_id, items, total, costo_envio, direccion_entrega, notas, metodo_pago, codigo_entrega, codigo_restaurante, palabras_verificacion, lat_entrega, lng_entrega)
      VALUES (${clienteId}, ${negocioId}, ${JSON.stringify(items)}, ${total}, ${envio}, ${direccionEntrega || ''}, ${notas || ''}, ${metodoPago || 'efectivo'}, ${codEntrega}, ${codRest}, ${JSON.stringify({ entrega: palabrasEntrega, restaurante: palabrasRestaurante })}, ${latEntrega || null}, ${lngEntrega || null})
      RETURNING *
    `;
    if (cuponCodigo) {
      await sql`UPDATE cupones SET usos_actual = usos_actual + 1 WHERE codigo = ${cuponCodigo}`.catch(() => {})
    }
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/pedidos/detalle/:id", async (req, res) => {
  try {
    const rows = await sql`
      SELECT p.*, v.nombre as negocio_nombre, v.imagen_url as negocio_imagen, v.direccion as negocio_direccion
      FROM pedidos p LEFT JOIN viveres v ON v.id = p.negocio_id
      WHERE p.id = ${req.params.id}
    `;
    res.json(rows[0] || null);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/pedidos/:userId", async (req, res) => {
  try {
    const rows = await sql`
      SELECT p.*, v.nombre as negocio_nombre, v.imagen_url as negocio_imagen,
             r.rating as repartidor_rating, r.vehiculo as repartidor_vehiculo
      FROM pedidos p LEFT JOIN viveres v ON v.id = p.negocio_id
      LEFT JOIN repartidores r ON r.id = p.repartidor_id
      WHERE p.cliente_id = ${req.params.userId}
      ORDER BY p.creado_en DESC LIMIT 20
    `;
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/pedidos/confirmar", async (req, res) => {
  try {
    const { pedidoId, codigo } = req.body;
    const rows = await sql`SELECT codigo_entrega FROM pedidos WHERE id = ${pedidoId}`;
    if (!rows[0]) return res.status(404).json({ error: "Pedido no encontrado" });
    if (rows[0].codigo_entrega !== codigo) return res.status(400).json({ error: "Codigo incorrecto" });
    await sql`UPDATE pedidos SET status = 'entregado' WHERE id = ${pedidoId}`;
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/pedidos/:id/cancelar", async (req, res) => {
  try {
    const rows = await sql`SELECT status FROM pedidos WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: "Pedido no encontrado" });
    const { status } = rows[0];
    if (!["nuevo", "preparando"].includes(status))
      return res.status(400).json({ error: "No se puede cancelar en este punto" });
    await sql`UPDATE pedidos SET status = 'cancelado', cancelado_en = NOW() WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/pedidos/:id/rating", async (req, res) => {
  try {
    const { rating_restaurante, rating_repartidor, comentario_rating } = req.body;
    await sql`UPDATE pedidos SET rating_restaurante = ${rating_restaurante}, rating_repartidor = ${rating_repartidor}, comentario_rating = ${comentario_rating || ''} WHERE id = ${req.params.id}`;
    if (rating_restaurante) {
      await sql`UPDATE viveres SET rating = (SELECT AVG(rating_restaurante) FROM pedidos WHERE negocio_id = (SELECT negocio_id FROM pedidos WHERE id = ${req.params.id}) AND rating_restaurante IS NOT NULL) WHERE id = (SELECT negocio_id FROM pedidos WHERE id = ${req.params.id})`;
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;