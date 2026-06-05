import { Router } from "express"
import { getAuth } from "@clerk/express"
import { sql } from "../db"
import { requireAuth, requireAuthUsuario } from "../middleware/auth"
import { logError } from "../logger"

const router = Router()

// ─── WALLET ──────────────────────────────────────────────────────────────────

// GET /api/usuario/wallet/:userId
router.get("/wallet/:userId", requireAuthUsuario, async (req, res) => {
  const authId = (req as any).usrUserId
  if (authId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const [user] = await sql`SELECT wallet_balance FROM usuarios WHERE id = ${req.params.userId}`
    const movimientos = await sql`
      SELECT * FROM wallet_movimientos
      WHERE usuario_id = ${req.params.userId}
      ORDER BY creado_en DESC LIMIT 20`
    res.json({ balance: Number(user?.wallet_balance || 0), movimientos })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/usuario/wallet/acreditar — uso interno (refunds, bienvenida)
router.post("/wallet/acreditar", requireAuth, async (req, res) => {
  try {
    const { usuarioId, monto, concepto, pedidoId } = req.body
    if (!usuarioId || !monto || !concepto) return res.status(400).json({ error: "Faltan campos" })
    await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance,0) + ${Number(monto)} WHERE id = ${usuarioId}`
    await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto, pedido_id)
      VALUES (${usuarioId}, 'credito', ${Number(monto)}, ${concepto}, ${pedidoId || null})`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ─── PUNTOS ───────────────────────────────────────────────────────────────────

// GET /api/usuario/puntos/:userId
router.get("/puntos/:userId", requireAuthUsuario, async (req, res) => {
  const authId = (req as any).usrUserId
  if (authId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const [user] = await sql`SELECT puntos FROM usuarios WHERE id = ${req.params.userId}`
    const historial = await sql`
      SELECT * FROM puntos_movimientos
      WHERE usuario_id = ${req.params.userId}
      ORDER BY creado_en DESC LIMIT 20`
    res.json({ puntos: Number(user?.puntos || 0), historial })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/usuario/puntos/canjear — 100 puntos = $10 cupón
router.post("/puntos/canjear", requireAuthUsuario, async (req, res) => {
  const authId = (req as any).usrUserId
  try {
    const [user] = await sql`SELECT puntos FROM usuarios WHERE id = ${authId}`
    if (!user || user.puntos < 100) return res.status(400).json({ error: "Necesitas al menos 100 puntos" })
    const bloques = Math.floor(user.puntos / 100)
    const descuento = bloques * 10
    const codigo = "PTS-" + authId.slice(-4).toUpperCase() + "-" + Date.now().toString(36).toUpperCase()
    await sql`INSERT INTO cupones (codigo, tipo, valor, usos_max, descripcion)
      VALUES (${codigo}, 'monto', ${descuento}, 1, ${'Canje de ' + user.puntos + ' puntos'})`
    await sql`UPDATE usuarios SET puntos = 0 WHERE id = ${authId}`
    await sql`INSERT INTO puntos_movimientos (usuario_id, puntos, concepto)
      VALUES (${authId}, ${-user.puntos}, ${'Canje por cupón ' + codigo})`
    res.json({ ok: true, codigo, descuento })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ─── REFERIDOS ────────────────────────────────────────────────────────────────

// GET /api/usuario/referral/:userId — obtener código propio
router.get("/referral/:userId", requireAuthUsuario, async (req, res) => {
  const authId = (req as any).usrUserId
  if (authId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    let [user] = await sql`SELECT referral_code FROM usuarios WHERE id = ${authId}`
    if (!user?.referral_code) {
      const code = "YV-" + authId.slice(-3).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase()
      await sql`UPDATE usuarios SET referral_code = ${code} WHERE id = ${authId}`
      user = { referral_code: code }
    }
    const refs = await sql`SELECT COUNT(*) as total FROM referidos WHERE referidor_id = ${authId}`
    res.json({ code: user.referral_code, referidosTotal: Number(refs[0]?.total || 0) })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/usuario/referral/usar — nuevo usuario aplica código de referido
router.post("/referral/usar", requireAuthUsuario, async (req, res) => {
  const authId = (req as any).usrUserId
  try {
    const { codigo } = req.body
    if (!codigo) return res.status(400).json({ error: "Código requerido" })
    const [referidor] = await sql`SELECT id FROM usuarios WHERE referral_code = ${codigo.toUpperCase()}`
    if (!referidor) return res.status(404).json({ error: "Código inválido" })
    if (referidor.id === authId) return res.status(400).json({ error: "No puedes usar tu propio código" })
    const yaUsado = await sql`SELECT id FROM referidos WHERE referido_id = ${authId}`
    if (yaUsado.length) return res.status(400).json({ error: "Ya usaste un código de referido" })
    await sql`INSERT INTO referidos (referidor_id, referido_id) VALUES (${referidor.id}, ${authId})`
    // Acreditar $15 al nuevo usuario (bienvenida)
    await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance,0) + 15 WHERE id = ${authId}`
    await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto)
      VALUES (${authId}, 'credito', 15, 'Bienvenida por código de referido')`
    res.json({ ok: true, bonus: 15 })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ─── NOTIFICACIONES IN-APP ───────────────────────────────────────────────────

// GET /api/usuario/notificaciones/:userId
router.get("/notificaciones/:userId", requireAuthUsuario, async (req, res) => {
  const authId = (req as any).usrUserId
  if (authId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const rows = await sql`
      SELECT * FROM notificaciones
      WHERE user_id = ${req.params.userId}
      ORDER BY creado_en DESC LIMIT 30`
    const noLeidas = rows.filter((r: any) => !r.leida).length
    res.json({ notificaciones: rows, noLeidas })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PATCH /api/usuario/notificaciones/:id/leer
router.patch("/notificaciones/:id/leer", requireAuthUsuario, async (req, res) => {
  try {
    await sql`UPDATE notificaciones SET leida = true WHERE id = ${req.params.id} AND user_id = ${(req as any).usrUserId}`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PATCH /api/usuario/notificaciones/todas/leer
router.patch("/notificaciones/todas/leer", requireAuthUsuario, async (req, res) => {
  try {
    await sql`UPDATE notificaciones SET leida = true WHERE user_id = ${(req as any).usrUserId}`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router

// Helper exportado para guardar notificación in-app al enviar push
export async function guardarNotificacion(
  userId: string, titulo: string, cuerpo: string,
  tipo = "general", datos?: Record<string, any>
) {
  try {
    await sql`INSERT INTO notificaciones (user_id, titulo, cuerpo, tipo, datos)
      VALUES (${userId}, ${titulo}, ${cuerpo}, ${tipo}, ${datos ? JSON.stringify(datos) : null})`
  } catch (e: any) { logError(e, "notificaciones:guardar") }
}
