import { Router } from "express";
import { sql } from "../db";

const router = Router();


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
const genDos = () => {
  const a = genCodigo();
  let b = genCodigo();
  while (b === a) b = genCodigo();
  return [a, b];
};

router.post("/pedidos", async (req, res) => {
  try {
    const { clienteId, negocioId, items, total, direccionEntrega, notas, metodoPago } = req.body;
    await sql`INSERT INTO usuarios (id, email, nombre, rol) VALUES (${clienteId}, '', '', 'cliente') ON CONFLICT (id) DO NOTHING`;
    const [codEntrega, codRest] = genDos();
    const rows = await sql`
      INSERT INTO pedidos (cliente_id, negocio_id, items, total, direccion_entrega, notas, metodo_pago, codigo_entrega, codigo_restaurante)
      VALUES (${clienteId}, ${negocioId}, ${JSON.stringify(items)}, ${total}, ${direccionEntrega || ''}, ${notas || ''}, ${metodoPago || 'efectivo'}, ${codEntrega}, ${codRest})
      RETURNING *
    `;
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
      SELECT p.*, v.nombre as negocio_nombre, v.imagen_url as negocio_imagen
      FROM pedidos p LEFT JOIN viveres v ON v.id = p.negocio_id
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


// Cancelar pedido (solo si status es nuevo o preparando)
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

// Calificar pedido
router.patch("/pedidos/:id/rating", async (req, res) => {
  try {
    const { rating_restaurante, rating_repartidor, comentario_rating } = req.body;
    await sql`UPDATE pedidos SET rating_restaurante = ${rating_restaurante}, rating_repartidor = ${rating_repartidor}, comentario_rating = ${comentario_rating || ''} WHERE id = ${req.params.id}`;
    // Actualizar rating promedio del negocio
    if (rating_restaurante) {
      await sql`UPDATE viveres SET rating = (SELECT AVG(rating_restaurante) FROM pedidos WHERE negocio_id = (SELECT negocio_id FROM pedidos WHERE id = ${req.params.id}) AND rating_restaurante IS NOT NULL) WHERE id = (SELECT negocio_id FROM pedidos WHERE id = ${req.params.id})`;
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
