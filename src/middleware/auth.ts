import { Request, Response, NextFunction } from "express"
import { supabase, sql } from "../db"

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
  const adminSecret = process.env.ADMIN_SECRET || ""
  const secretHeader = req.headers["x-admin-secret"] || req.headers["authorization"]?.replace("Bearer ", "")
  if (adminSecret && secretHeader === adminSecret) {
    return next()
  }
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

export async function requireNegocioOwner(req: Request, res: Response, next: NextFunction) {
  const uid = (req as any).userId || (await extractUid(req))
  if (!uid) return res.status(401).json({ error: "No autorizado" })
  ;(req as any).userId = uid

  const negocioId = req.params.id || req.body?.negocioId || req.body?.negocio_id
  if (!negocioId || ADMIN_IDS.includes(uid)) return next()

  try {
    const rows = await sql`SELECT user_id FROM viveres WHERE id = ${negocioId} LIMIT 1`
    if (rows.length && rows[0].user_id && rows[0].user_id !== uid) {
      return res.status(403).json({ error: "No tienes permiso para administrar este negocio" })
    }
  } catch {}
  next()
}
