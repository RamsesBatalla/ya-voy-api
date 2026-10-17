import { Router } from "express"
import { sql } from "../db"
import { sendPushToUser } from "../firebase"
import { requireAuth, requireAdmin } from "../middleware/auth"
import { notificarSolicitudRetiro } from "../notificationsAdmin"

const router = Router()

const initTable = async () => {
  await sql`CREATE TABLE IF NOT EXISTS retiros (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo_actor TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_nombre TEXT,
    monto NUMERIC NOT NULL,
    status TEXT DEFAULT 'pendiente',
    fecha_solicitud TIMESTAMPTZ DEFAULT NOW(),
    fecha_pago TIMESTAMPTZ,
    nota_admin TEXT,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`
  await sql`ALTER TABLE retiros ADD COLUMN IF NOT EXISTS creado_en TIMESTAMPTZ DEFAULT NOW()`
}
initTable().catch(e => console.error("Error init retiros:", e.message))

async function calcularSaldoActor(tipo: string, actorId: string) {
  const cfg = await sql`SELECT clave, valor FROM app_config WHERE clave IN ('comision_pct','envio_minimo')`
  const cfgMap: Record<string, number> = {}
  cfg.forEach((r: any) => { cfgMap[r.clave] = parseFloat(r.valor) })
  const comisionPct = (cfgMap.comision_pct ?? 18) / 100
  const envioMin = cfgMap.envio_minimo ?? 25

  let ganadoTarjeta = 0
  let cobradoEfectivo = 0
  let deudaEfectivo = 0
  let ownerUserId = actorId

  if (tipo === "repartidor") {
    // Modelo Opción B:
    // - En pedidos con tarjeta: Ya Voy cobra todo y le abona (costo_envio + propina) al saldo bancario del repartidor.
    // - En pedidos en efectivo: El repartidor paga la comida en el restaurante al recoger y cobra el total al cliente,
    //   quedándose en mano con (costo_envio + propina) en efectivo al instante (no es retirable por banco).
    const rows = await sql`
      SELECT
        COALESCE(SUM(CASE WHEN metodo_pago = 'tarjeta' THEN COALESCE(costo_envio, ${envioMin}) + COALESCE(propina, 0) ELSE 0 END), 0) as total_tarjeta,
        COALESCE(SUM(CASE WHEN COALESCE(metodo_pago, 'efectivo') = 'efectivo' THEN COALESCE(costo_envio, ${envioMin}) + COALESCE(propina, 0) ELSE 0 END), 0) as total_efectivo
      FROM pedidos
      WHERE repartidor_id = ${actorId} AND status = 'entregado'
    `
    const [repRow] = await sql`
      SELECT COALESCE(deuda_efectivo, 0) as deuda
      FROM repartidores
      WHERE id = ${actorId} OR usuario_id = ${actorId} OR user_id = ${actorId}
      LIMIT 1
    `.catch(() => [{ deuda: 0 }])

    deudaEfectivo = Number(repRow?.deuda || 0)
    ganadoTarjeta = Number(rows[0]?.total_tarjeta || 0)
    cobradoEfectivo = Number(rows[0]?.total_efectivo || 0)
  } else if (tipo === "restaurante") {
    const negocio = await sql`
      SELECT id, COALESCE(owner_id, user_id) as owner_id
      FROM viveres
      WHERE owner_id = ${actorId} OR user_id = ${actorId} OR id::text = ${actorId}
      LIMIT 1
    `
    if (negocio.length) {
      ownerUserId = negocio[0].owner_id || actorId
      // En pedidos con tarjeta (o compensados por falta de repartidor): Ya Voy retiene la comisión y abona el neto al saldo bancario retirable por CLABE.
      // En pedidos en efectivo: El restaurante recibe el pago en efectivo directamente en caja (al recolectar el repartidor o en pickup).
      const rows = await sql`
        SELECT
          COALESCE(SUM(
            CASE
              WHEN status = 'cancelado' AND compensar_restaurante = true
                THEN GREATEST(0, total - COALESCE(costo_envio, ${envioMin}) - COALESCE(propina, 0)) * ${1 - comisionPct}
              WHEN status = 'entregado' AND metodo_pago = 'tarjeta'
                THEN GREATEST(0, total - COALESCE(costo_envio, 0) - COALESCE(propina, 0)) * ${1 - comisionPct}
              ELSE 0
            END
          ), 0) as total_tarjeta,
          COALESCE(SUM(
            CASE
              WHEN status = 'entregado' AND COALESCE(metodo_pago, 'efectivo') = 'efectivo'
                THEN GREATEST(0, total - COALESCE(costo_envio, 0) - COALESCE(propina, 0))
              ELSE 0
            END
          ), 0) as total_efectivo
        FROM pedidos
        WHERE negocio_id = ${negocio[0].id}
          AND (status = 'entregado' OR (status = 'cancelado' AND compensar_restaurante = true))
      `
      ganadoTarjeta = Number(rows[0]?.total_tarjeta || 0)
      cobradoEfectivo = Number(rows[0]?.total_efectivo || 0)
    }
  }

  const retiradoRows = await sql`
    SELECT COALESCE(SUM(monto), 0) as total FROM retiros
    WHERE tipo_actor = ${tipo} AND (actor_id = ${actorId} OR actor_id = ${ownerUserId}) AND status != 'rechazado'
  `
  const retirado = Number(retiradoRows[0]?.total || 0)
  const ganado = Math.max(0, Math.round((ganadoTarjeta - deudaEfectivo) * 100) / 100)
  const disponible = Math.max(0, Math.round((ganado - retirado) * 100) / 100)

  return {
    ganado,
    ganadoTarjeta: Math.round(ganadoTarjeta * 100) / 100,
    cobradoEfectivo: Math.round(cobradoEfectivo * 100) / 100,
    deudaEfectivo: Math.round(deudaEfectivo * 100) / 100,
    retirado: Math.round(retirado * 100) / 100,
    disponible,
    ownerUserId,
  }
}

// GET /api/retiros — todos (dashboard admin)
router.get("/", requireAdmin, async (_req, res) => {
  try {
    const rows = await sql`SELECT * FROM retiros ORDER BY fecha_solicitud DESC LIMIT 200`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /api/retiros/:tipo/:actorId — retiros propios
router.get("/:tipo/:actorId", requireAuth, async (req, res) => {
  const userId = (req as any).userId
  try {
    if (userId !== req.params.actorId) {
      const check = await sql`SELECT id FROM viveres WHERE id::text = ${req.params.actorId} AND (owner_id = ${userId} OR user_id = ${userId}) LIMIT 1`
      if (!check.length) return res.status(403).json({ error: "Acceso denegado" })
    }
    const rows = await sql`
      SELECT * FROM retiros
      WHERE tipo_actor = ${req.params.tipo} AND (actor_id = ${req.params.actorId} OR actor_id = ${userId})
      ORDER BY fecha_solicitud DESC LIMIT 50`
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /api/retiros/saldo/:tipo/:actorId — saldo propio desglosado (Tarjeta retirable por CLABE vs Efectivo cobrado en mano)
router.get("/saldo/:tipo/:actorId", requireAuth, async (req, res) => {
  const userId = (req as any).userId
  try {
    const { tipo, actorId } = req.params
    const saldo = await calcularSaldoActor(tipo, actorId)
    if (userId !== actorId && userId !== saldo.ownerUserId) {
      return res.status(403).json({ error: "Acceso denegado" })
    }
    res.json(saldo)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/retiros — solicitar retiro bancario por CLABE
router.post("/", requireAuth, async (req, res) => {
  try {
    const { tipo_actor, actor_id, actor_nombre, monto } = req.body
    const montoNum = Number(monto)
    if (!tipo_actor || !actor_id || !montoNum || montoNum <= 0)
      return res.status(400).json({ error: "Datos inválidos" })

    const cfg = await sql`SELECT valor FROM app_config WHERE clave = 'retiro_minimo'`
    const minimo = Number(cfg[0]?.valor || 50)
    if (montoNum < minimo)
      return res.status(400).json({ error: "El monto mínimo de retiro bancario es de $" + minimo + " MXN" })

    const pendiente = await sql`
      SELECT id FROM retiros
      WHERE tipo_actor = ${tipo_actor} AND actor_id = ${actor_id} AND status = 'pendiente'`
    if (pendiente.length > 0)
      return res.status(409).json({ error: "Ya tienes una solicitud de retiro en proceso." })

    // Verificar saldo digital real disponible (solo pagos con tarjeta / compensaciones)
    const saldo = await calcularSaldoActor(tipo_actor, actor_id)
    if (montoNum > saldo.disponible + 0.5) {
      return res.status(400).json({
        error: `Tu saldo bancario disponible para retiro por CLABE es de $${saldo.disponible.toFixed(2)} MXN (los pedidos en efectivo ya fueron cobrados en mano).`
      })
    }

    // Obtener datos bancarios CLABE para incluirlos en la notificación al Admin
    let clabe: string | null = null
    let banco: string | null = null
    let titular: string | null = null
    if (tipo_actor === "restaurante") {
      const vRows = await sql`SELECT clabe_bancaria, banco_nombre, titular_cuenta, nombre FROM viveres WHERE owner_id = ${actor_id} OR user_id = ${actor_id} OR id::text = ${actor_id} LIMIT 1`
      clabe = vRows[0]?.clabe_bancaria || null
      banco = vRows[0]?.banco_nombre || null
      titular = vRows[0]?.titular_cuenta || null
    } else {
      const rRows = await sql`SELECT clabe_bancaria, banco_nombre, titular_cuenta, nombre FROM repartidores WHERE id = ${actor_id} OR usuario_id = ${actor_id} OR user_id = ${actor_id} LIMIT 1`
      clabe = rRows[0]?.clabe_bancaria || null
      banco = rRows[0]?.banco_nombre || null
      titular = rRows[0]?.titular_cuenta || null
    }

    if (!clabe) {
      return res.status(400).json({ error: "Debes registrar y guardar tu CLABE interbancaria de 18 dígitos antes de solicitar un retiro." })
    }

    const rows = await sql`
      INSERT INTO retiros (tipo_actor, actor_id, actor_nombre, monto)
      VALUES (${tipo_actor}, ${actor_id}, ${actor_nombre || titular || ""}, ${montoNum})
      RETURNING *`

    notificarSolicitudRetiro({
      retiroId: String(rows[0].id),
      actorNombre: actor_nombre || titular || actor_id,
      tipoActor: tipo_actor,
      monto: montoNum,
      actorId: actor_id,
      clabe,
      banco,
      titular,
    }).catch(() => {})

    res.json(rows[0])
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PATCH /api/retiros/:id — aprobar/rechazar (solo admin)
router.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const { status, nota_admin } = req.body
    const fechaPago = status === "pagado" ? new Date().toISOString() : null
    const rows = await sql`
      UPDATE retiros SET status = ${status}, nota_admin = ${nota_admin || ""},
        fecha_pago = ${fechaPago}
      WHERE id = ${req.params.id} RETURNING *`
    const retiro = rows[0]
    if (status === "pagado" || status === "rechazado") {
      const titulo = status === "pagado" ? "Retiro aprobado \u2705" : "Retiro rechazado \u274c"
      const monto = Number(retiro.monto).toFixed(2)
      const cuerpo = status === "pagado" ? `Tu retiro de $${monto} MXN fue aprobado y pagado` : `Tu retiro de $${monto} MXN fue rechazado${nota_admin ? ": " + nota_admin : ""}`
      sendPushToUser(sql, retiro.actor_id, titulo, cuerpo).catch(() => {})
    }
    res.json(retiro)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router

