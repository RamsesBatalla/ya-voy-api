import { Request, Response, NextFunction } from "express"
import { getAuth } from "@clerk/express"

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req)
  if (!userId) return res.status(401).json({ error: "No autorizado" })
  next()
}

const adminIds = () =>
  (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean)

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req)
  if (!userId) return res.status(401).json({ error: "No autorizado" })
  if (!adminIds().includes(userId)) return res.status(403).json({ error: "Acceso denegado" })
  next()
}
