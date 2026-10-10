import { Router, Request, Response, NextFunction } from "express"
import { sql } from "../db"
import { sendPushToUser } from "../firebase"
import { requireAdmin } from "../middleware/auth"

const router = Router()

const ADMIN_SECRET = process.env.ADMIN_SECRET || ""

function requireAdminSecret(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers["x-admin-secret"] || req.headers["authorization"]?.replace("Bearer ", "")
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) return res.status(403).json({ error: "No autorizado" })
  next()
}

// POST /api/admin/aprobar-repartidor  { usuarioId }
router.post("/aprobar-repartidor", requireAdmin, async (req, res) => {
  try {
    const { usuarioId } = req.body
    if (!usuarioId) return res.status(400).json({ error: "usuarioId requerido" })

    // Obtener datos de la solicitud
    const solRows = await sql`SELECT datos FROM solicitudes WHERE usuario_id = ${usuarioId} AND tipo = 'repartidor'`
    const datos = solRows[0]?.datos || {}

    // 1. Crear o activar registro de repartidor
    await sql`
      INSERT INTO repartidores (id, usuario_id, nombre, email, telefono, vehiculo_tipo, vehiculo_modelo, vehiculo_placas, disponible, activo)
      VALUES (${usuarioId}, ${usuarioId}, ${datos.nombre || "Repartidor"}, ${datos.email || ""}, ${datos.telefono || ""}, ${datos.vehiculo_tipo || "moto"}, ${datos.vehiculo_modelo || ""}, ${datos.vehiculo_placas || ""}, true, true)
      ON CONFLICT (id) DO UPDATE SET disponible = true, activo = true, vehiculo_tipo = ${datos.vehiculo_tipo || "moto"}
    `

    // 2. Marcar solicitud aprobada y BORRAR DOCUMENTOS (INE/Licencia) por privacidad y espacio
    await sql`UPDATE solicitudes SET status = 'aprobado', documentos = '{}'::jsonb, razon_rechazo = NULL WHERE usuario_id = ${usuarioId} AND tipo = 'repartidor'`

    await sendPushToUser(
      sql, usuarioId,
      "¡Fuiste aprobado como repartidor! 🛵",
      "Ya puedes conectarte y empezar a recibir pedidos.",
      { tipo: "aprobacion", rol: "repartidor" }
    )
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/rechazar-repartidor  { usuarioId, razon }
router.post("/rechazar-repartidor", requireAdmin, async (req, res) => {
  try {
    const { usuarioId, razon } = req.body
    if (!usuarioId) return res.status(400).json({ error: "usuarioId requerido" })

    // Marcar solicitud rechazada y BORRAR DOCUMENTOS (INE/Licencia) por privacidad y espacio
    await sql`UPDATE solicitudes SET status = 'rechazado', razon_rechazo = ${razon || "Inconsistencia de documentos"}, documentos = '{}'::jsonb WHERE usuario_id = ${usuarioId} AND tipo = 'repartidor'`

    await sendPushToUser(
      sql, usuarioId,
      "Solicitud de repartidor rechazada",
      razon || "Tu solicitud no fue aprobada. Puedes volver a intentarlo.",
      { tipo: "rechazo", rol: "repartidor" }
    )
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/aprobar-restaurante  { usuarioId, nombreNegocio }
router.post("/aprobar-restaurante", requireAdmin, async (req, res) => {
  try {
    const { usuarioId, nombreNegocio } = req.body
    if (!usuarioId) return res.status(400).json({ error: "usuarioId requerido" })
    await sendPushToUser(
      sql, usuarioId,
      `¡${nombreNegocio || "Tu negocio"} fue aprobado! 🎉`,
      "Ya apareces en la app. Completa tu menú y empieza a recibir pedidos.",
      { tipo: "aprobacion", rol: "restaurante" }
    )
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/rechazar-restaurante  { usuarioId, razon }
router.post("/rechazar-restaurante", requireAdmin, async (req, res) => {
  try {
    const { usuarioId, razon } = req.body
    if (!usuarioId) return res.status(400).json({ error: "usuarioId requerido" })
    await sendPushToUser(
      sql, usuarioId,
      "Solicitud de negocio rechazada",
      razon || "Tu solicitud no fue aprobada en este momento.",
      { tipo: "rechazo", rol: "restaurante" }
    )
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/reset-datos-prueba  { confirmacion: "BORRAR_TODO" }
// Elimina TODOS los datos de prueba: usuarios, solicitudes, negocios, repartidores, pedidos
router.post("/reset-datos-prueba", requireAdminSecret, async (req, res) => {
  if (req.body.confirmacion !== "BORRAR_TODO") return res.status(400).json({ error: "confirmacion requerida: BORRAR_TODO" })
  try {
    await sql`DELETE FROM mensajes`
    await sql`DELETE FROM device_tokens`
    await sql`DELETE FROM favoritos`
    await sql`DELETE FROM direcciones`
    await sql`DELETE FROM cupones`
    await sql`DELETE FROM retiros`
    await sql`DELETE FROM reportes_soporte`
    await sql`DELETE FROM pedidos`
    await sql`DELETE FROM productos`
    await sql`DELETE FROM repartidores`
    await sql`DELETE FROM viveres`
    await sql`DELETE FROM solicitudes`
    await sql`DELETE FROM usuarios`
    res.json({ ok: true, mensaje: "Todos los datos eliminados" })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
