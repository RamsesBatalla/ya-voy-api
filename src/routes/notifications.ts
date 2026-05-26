import { Router } from "express"
import { sql } from "../db"
import { getAuth } from "@clerk/express"

const router = Router()

// Guardar token FCM del dispositivo
router.post("/token", async (req, res) => {
  try {
    const { userId } = getAuth(req)
    const { token } = req.body
    if (!userId || !token) return res.status(400).json({ error: "userId y token requeridos" })
    await sql`
      INSERT INTO device_tokens (user_id, token, updated_at)
      VALUES (${userId}, ${token}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET token = ${token}, updated_at = NOW()
    `
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router