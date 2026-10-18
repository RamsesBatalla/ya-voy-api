import { Router } from "express"
import { sql } from "../db"
import { sendPushToUser } from "../firebase"
import { requireAdmin, verifyTokenAny } from "../middleware/auth"
const router = Router()

// Guardar token FCM del dispositivo
router.post("/token", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"]?.replace("Bearer ", "");
    const authUserId = authHeader ? await verifyTokenAny(authHeader) : null;
    const { token, userId: bodyUserId } = req.body;
    const finalUserId = authUserId || bodyUserId;
    if (!finalUserId || !token) return res.status(400).json({ error: "No autorizado o token faltante" });
    await sql`
      INSERT INTO device_tokens (user_id, token, updated_at)
      VALUES (${finalUserId}, ${token}, NOW())
      ON CONFLICT (user_id, token) DO UPDATE SET updated_at = NOW()
    `;
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/notificaciones/push - solo admins pueden enviar push
router.post("/push", requireAdmin, async (req, res) => {
  try {
    const { userId, titulo, cuerpo, data } = req.body
    if (!userId || !titulo || !cuerpo) return res.status(400).json({ error: "userId, titulo y cuerpo requeridos" })
    await sendPushToUser(sql, userId, titulo, cuerpo, data || {})
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
