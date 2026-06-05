import { Request, Response, NextFunction } from "express"
import { getAuth, verifyToken } from "@clerk/express"

const KEY_MAIN = process.env.CLERK_SECRET_KEY || ""
const KEY_USR  = process.env.CLERK_SECRET_KEY_USUARIO || process.env.CLERK_SECRET_KEY || ""
const KEY_REP  = process.env.CLERK_SECRET_KEY_REPARTIDOR || process.env.CLERK_SECRET_KEY || ""

export const ADMIN_IDS = (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean)

// ── Restaurante (Clerk principal) ─────────────────────────────────────────────
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req)
  if (!userId) return res.status(401).json({ error: "No autorizado" })
  next()
}

// ── Admin (Clerk principal + lista de IDs) ────────────────────────────────────
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req)
  if (!userId || !ADMIN_IDS.includes(userId)) {
    res.status(403).json({ error: "No autorizado" }); return
  }
  next()
}

// ── Usuario ───────────────────────────────────────────────────────────────────
export async function requireAuthUsuario(req: Request, res: Response, next: NextFunction) {
  const token = req.headers["authorization"]?.replace("Bearer ", "")
  if (!token) return res.status(401).json({ error: "No autorizado" })
  try {
    const payload = await verifyToken(token, { secretKey: KEY_USR })
    ;(req as any).usrUserId = payload.sub
    next()
  } catch {
    res.status(401).json({ error: "No autorizado" })
  }
}

// ── Repartidor ────────────────────────────────────────────────────────────────
export async function requireAuthRepartidor(req: Request, res: Response, next: NextFunction) {
  const token = req.headers["authorization"]?.replace("Bearer ", "")
  if (!token) return res.status(401).json({ error: "No autorizado" })
  try {
    const payload = await verifyToken(token, { secretKey: KEY_REP })
    ;(req as any).repUserId = payload.sub
    next()
  } catch {
    res.status(401).json({ error: "No autorizado" })
  }
}

// ── Helper WS: prueba las 3 instancias, devuelve userId o null ─────────────────
export async function verifyTokenAny(token: string): Promise<string | null> {
  for (const key of [KEY_MAIN, KEY_USR, KEY_REP]) {
    try {
      const payload = await verifyToken(token, { secretKey: key })
      return payload.sub
    } catch {}
  }
  return null
}
