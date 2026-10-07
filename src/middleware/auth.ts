import { Request, Response, NextFunction } from "express"
import admin from "firebase-admin"

export const ADMIN_IDS = (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean)

async function extractUid(req: Request): Promise<string | null> {
  const token = req.headers["authorization"]?.replace("Bearer ", "")
  if (!token) return null
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    return decoded.uid
  } catch {
    return null
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const uid = await extractUid(req)
  if (!uid) return res.status(401).json({ error: "No autorizado" })
  ;(req as any).userId = uid
  next()
}

export async function requireAuthUsuario(req: Request, res: Response, next: NextFunction) {
  const uid = await extractUid(req)
  if (!uid) return res.status(401).json({ error: "No autorizado" })
  ;(req as any).usrUserId = uid
  next()
}

export async function requireAuthRepartidor(req: Request, res: Response, next: NextFunction) {
  const uid = await extractUid(req)
  if (!uid) return res.status(401).json({ error: "No autorizado" })
  ;(req as any).repUserId = uid
  next()
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const uid = await extractUid(req)
  if (!uid || !ADMIN_IDS.includes(uid)) {
    res.status(403).json({ error: "No autorizado" }); return
  }
  ;(req as any).userId = uid
  next()
}

export async function verifyTokenAny(token: string): Promise<string | null> {
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    return decoded.uid
  } catch {
    return null
  }
}
