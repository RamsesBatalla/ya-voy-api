import { Request, Response, NextFunction } from "express"
import { supabase, sql } from "../db"

export const ADMIN_IDS = (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean)

function decodeJwtSub(token: string): string | null {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    
    // Supabase JWT (payload.aud === "authenticated")
    if (payload?.sub && typeof payload.sub === "string" && payload?.aud === "authenticated") {
      return payload.sub
    }
    // Firebase Auth ID token (issuer contains securetoken.google.com or has firebase claim, sub is the UID)
    if (payload?.sub && typeof payload.sub === "string" && (payload?.iss?.includes("securetoken.google.com") || payload?.firebase)) {
      return payload.sub
    }
    // Generic user ID payload fallback
    if (payload?.user_id && typeof payload.user_id === "string") {
      return payload.user_id
    }
    if (payload?.sub && typeof payload.sub === "string") {
      return payload.sub
    }
    return null
  } catch {
    return null
  }
}

async function extractUid(req: Request): Promise<string | null> {
  const token = req.headers["authorization"]?.replace("Bearer ", "")
  const customUserId = (req.headers["x-user-id"] || req.headers["x-client-id"]) as string | undefined
  if (!token) return customUserId || null
  try {
    const jwtSub = decodeJwtSub(token)
    if (jwtSub) return jwtSub
    const { data: { user } } = await supabase.auth.getUser(token)
    if (user?.id) return user.id
    // Fallback for dev/test user ID string headers
    if (token.startsWith("user_") || token.startsWith("rep_") || token.startsWith("rest_") || token.startsWith("dev_")) {
      return token
    }
    return customUserId || null
  } catch {
    const jwtSub = decodeJwtSub(token)
    if (jwtSub) return jwtSub
    if (token.startsWith("user_") || token.startsWith("rep_") || token.startsWith("rest_") || token.startsWith("dev_")) {
      return token
    }
    return customUserId || null
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
  ;(req as any).userId = uid
  next()
}

export async function requireAuthRepartidor(req: Request, res: Response, next: NextFunction) {
  const uid = await extractUid(req)
  if (!uid) return res.status(401).json({ error: "No autorizado" })
  ;(req as any).repUserId = uid
  ;(req as any).userId = uid
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
    if (user?.id) return user.id
    const jwtSub = decodeJwtSub(token)
    if (jwtSub) return jwtSub
    return token.startsWith("user_") || token.startsWith("rep_") ? token : null
  } catch {
    const jwtSub = decodeJwtSub(token)
    if (jwtSub) return jwtSub
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
    const rows = await sql`SELECT COALESCE(owner_id, user_id) as owner_id FROM viveres WHERE id::text = ${negocioId} LIMIT 1`
    if (rows.length && rows[0].owner_id && rows[0].owner_id !== uid) {
      return res.status(403).json({ error: "No tienes permiso para administrar este negocio" })
    }
  } catch {}
  next()
}
