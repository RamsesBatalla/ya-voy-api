import { Request, Response, NextFunction } from "express"
import { supabase } from "../db"

export const ADMIN_IDS = (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean)

async function extractUid(req: Request): Promise<string | null> {
  const token = req.headers["authorization"]?.replace("Bearer ", "")
  if (!token) return null
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (user?.id) return user.id
    // Fallback for dev/test user ID string headers
    if (token.startsWith("user_") || token.startsWith("rep_") || token.startsWith("rest_") || token.startsWith("dev_")) {
      return token
    }
    return null
  } catch {
    if (token.startsWith("user_") || token.startsWith("rep_") || token.startsWith("rest_") || token.startsWith("dev_")) {
      return token
    }
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
    const { data: { user } } = await supabase.auth.getUser(token)
    return user?.id || (token.startsWith("user_") || token.startsWith("rep_") ? token : null)
  } catch {
    return token.startsWith("user_") || token.startsWith("rep_") ? token : null
  }
}
