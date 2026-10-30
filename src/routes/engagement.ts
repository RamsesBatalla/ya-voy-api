import { Router } from "express"
import { sql } from "../db"
import { requireAuth, requireAuthUsuario, requireAdmin } from "../middleware/auth"
import { logError } from "../logger"
import { sendPushToUser } from "../firebase"

const router = Router()

// ─── WALLET ──────────────────────────────────────────────────────────────────

// GET /api/usuario/wallet/:userId
router.get("/wallet/:userId", requireAuthUsuario, async (req, res) => {
  const authId = (req as any).usrUserId || (req as any).userId
  if (authId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const [user] = await sql`SELECT wallet_balance FROM usuarios WHERE id = ${req.params.userId}`
    // Filtrar movimientos de los últimos 7 días como solicitó el usuario
    const movimientos = await sql`
      SELECT * FROM wallet_movimientos
      WHERE usuario_id = ${req.params.userId}
        AND creado_en >= NOW() - INTERVAL '7 days'
      ORDER BY creado_en DESC LIMIT 50`
    res.json({ balance: Number(user?.wallet_balance || 0), movimientos })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/usuario/wallet/acreditar — uso interno (refunds, bienvenida)
router.post("/wallet/acreditar", requireAdmin, async (req, res) => {
  try {
    const { usuarioId, monto, concepto, pedidoId } = req.body
    if (!usuarioId || !monto || !concepto) return res.status(400).json({ error: "Faltan campos" })
    await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance,0) + ${Number(monto)} WHERE id = ${usuarioId}`
    await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto, pedido_id)
      VALUES (${usuarioId}, 'credito', ${Number(monto)}, ${concepto}, ${pedidoId || null})`
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /api/usuario/wallet/recompensa-video/status/:userId
router.get("/wallet/recompensa-video/status/:userId", requireAuthUsuario, async (req, res) => {
  const authId = (req as any).usrUserId || (req as any).userId
  if (authId !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" })
  try {
    const [rows] = await sql`
      SELECT COUNT(*)::int as count FROM wallet_movimientos 
      WHERE usuario_id = ${authId} 
        AND (concepto ILIKE '%video%' OR concepto ILIKE '%publicitario%')
        AND (creado_en AT TIME ZONE 'America/Mexico_City')::date = (NOW() AT TIME ZONE 'America/Mexico_City')::date
    `
    res.json({ videosHoy: Number(rows?.count || 0), maxVideos: 10, recompensaPorVideo: 0.25 })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/usuario/wallet/recompensa-video
router.post("/wallet/recompensa-video", requireAuthUsuario, async (req, res) => {
  const authId = (req as any).usrUserId || (req as any).userId
  try {
    const [check] = await sql`
      SELECT COUNT(*)::int as count FROM wallet_movimientos 
      WHERE usuario_id = ${authId} 
        AND (concepto ILIKE '%video%' OR concepto ILIKE '%publicitario%')
        AND (creado_en AT TIME ZONE 'America/Mexico_City')::date = (NOW() AT TIME ZONE 'America/Mexico_City')::date
    `
    const videosHoy = Number(check?.count || 0)
    if (videosHoy >= 10) {
      return res.status(400).json({ 
        error: "Has alcanzado el límite de 10 videos por hoy. ¡El contador se reiniciará a la medianoche (12:00 AM hora México)! Vuelve mañana.",
        videosHoy: 10,
        maxVideos: 10
      })
    }

    const recompensa = 0.25 // $0.25 MXN por video visto
    await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance, 0) + ${recompensa} WHERE id = ${authId}`
    await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto)
      VALUES (${authId}, 'credito', ${recompensa}, 'Recompensa video publicitario (AdMob)')`

    const [user] = await sql`SELECT wallet_balance FROM usuarios WHERE id = ${authId}`
    res.json({ 
      ok: true, 
      montoAcreditado: recompensa, 
      nuevoBalance: Number(user?.wallet_balance || 0), 
      videosHoy: videosHoy + 1, 
      maxVideos: 10 
    })
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
    await sql`INSERT INTO cupones (codigo, tipo, valor, usos_max)
      VALUES (${codigo}, 'monto', ${descuento}, 1)`
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
  const authId = (req as any).usrUserId || (req as any).userId
  try {
    const { codigo } = req.body
    if (!codigo) return res.status(400).json({ error: "Código requerido" })
    const [referidor] = await sql`SELECT id FROM usuarios WHERE UPPER(referral_code) = ${codigo.toUpperCase()}`
    if (!referidor) return res.status(404).json({ error: "Código inválido" })
    if (referidor.id === authId) return res.status(400).json({ error: "No puedes usar tu propio código" })
    const yaUsado = await sql`SELECT id FROM referidos WHERE referido_id = ${authId}`
    if (yaUsado.length) return res.status(400).json({ error: "Ya usaste un código de referido" })
    await sql`INSERT INTO referidos (referidor_id, referido_id) VALUES (${referidor.id}, ${authId})`

    // Acreditar $15 al nuevo usuario (bienvenida)
    await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance,0) + 15 WHERE id = ${authId}`
    await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto)
      VALUES (${authId}, 'credito', 15, 'Bienvenida por código de referido')`

    // Acreditar $15 al amigo referidor (bono por invitar)
    await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance,0) + 15 WHERE id = ${referidor.id}`
    await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto)
      VALUES (${referidor.id}, 'credito', 15, 'Bono por amigo referido')`

    // Notificación push al referidor
    sendPushToUser(sql, referidor.id, "🎉 ¡Amigo referido registrado!", "¡Un amigo usó tu código! Se acreditaron +$15 MXN a tu monedero Ya Voy.", {
      tipo: "referido_bono",
      monto: "15"
    }).catch(() => {})

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
