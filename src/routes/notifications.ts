import { Router } from "express"
import { sql } from "../db"
import { getAuth } from "@clerk/express"
import { sendPushToUser } from "../firebase"
import { verifyTokenAny } from "../middleware/auth"
const router = Router()

// Guardar token FCM del dispositivo — acepta JWT de las 3 instancias Clerk
router.post("/token", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"]?.replace("Bearer ", "")
    const userId = authHeader ? await verifyTokenAny(authHeader) : null
    const { token } = req.body
    if (!userId || !token) return res.status(400).json({ error: "No autorizado o token faltante" })
    await sql`
      INSERT INTO device_tokens (user_id, token, updated_at)
      VALUES (${userId}, ${token}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET token = ${token}, updated_at = NOW()
    `
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/notificaciones/push - solo admins pueden enviar push
router.post("/push", async (req, res) => {
  try {
    const { userId: adminId } = getAuth(req)
    const ADMIN_IDS = (process.env.ADMIN_USER_IDS || "").split(",")
    if (!adminId || !ADMIN_IDS.includes(adminId)) return res.status(403).json({ error: "No autorizado" })
    const { userId, titulo, cuerpo, data } = req.body
    if (!userId || !titulo || !cuerpo) return res.status(400).json({ error: "userId, titulo y cuerpo requeridos" })
    await sendPushToUser(sql, userId, titulo, cuerpo, data || {})
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router