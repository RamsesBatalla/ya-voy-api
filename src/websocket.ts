import { WebSocketServer, WebSocket } from "ws"
import { IncomingMessage } from "http"
import { Server } from "http"
import { verifyTokenAny } from "./middleware/auth"
import { sql } from "./db"
import { sendPushToUser } from "./firebase"

// ── Ubicación repartidor ──────────────────────────────────────────────────────
const suscriptores = new Map<string, Set<WebSocket>>()
const ubicaciones  = new Map<string, { lat: number; lng: number }>()

// ── Pedidos en tiempo real ────────────────────────────────────────────────────
const pedidoClientes = new Map<string, Set<WebSocket>>() // userId → conexiones

export function notificarCliente(clienteId: string, tipo: string, data: unknown) {
  const conns = pedidoClientes.get(clienteId)
  if (!conns || conns.size === 0) return
  const msg = JSON.stringify({ tipo, data })
  conns.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg) })
}

export function initWebSocket(server: Server) {
  const wss = new WebSocketServer({ server })

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const url    = new URL(req.url || "", "http://localhost")
    const path   = url.pathname
    const token  = url.searchParams.get("token") || ""

    // ── Ruta ubicación ───────────────────────────────────────────────────────
    if (path === "/ws/ubicacion") {
      const repartidorId = url.searchParams.get("repartidorId") || ""
      const rol           = url.searchParams.get("rol") || "cliente"

      if (!repartidorId) { ws.close(1008, "repartidorId requerido"); return }

      if (rol === "repartidor") {
        // El repartidor debe enviar su propio token para verificar identidad
        if (!token) { ws.close(1008, "token requerido"); return }
        const authUserId = await verifyTokenAny(token)
        if (!authUserId || authUserId !== repartidorId) { ws.close(1008, "No autorizado"); return }

        ws.on("message", (data) => {
          try {
            const { lat, lng } = JSON.parse(data.toString())
            if (!lat || !lng) return
            ubicaciones.set(repartidorId, { lat, lng })
            const clientes = suscriptores.get(repartidorId)
            if (clientes) {
              const msg = JSON.stringify({ lat, lng, ts: Date.now() })
              clientes.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg) })
            }
          } catch (e: any) { console.error("WS ubicacion parse:", e.message) }
        })
        ws.on("close", () => { ubicaciones.delete(repartidorId) })

      } else {
        // Cliente suscrito a la ubicación del repartidor — requiere token válido
        if (!token) { ws.close(1008, "token requerido"); return }
        const authUserId = await verifyTokenAny(token)
        if (!authUserId) { ws.close(1008, "No autorizado"); return }

        if (!suscriptores.has(repartidorId)) suscriptores.set(repartidorId, new Set())
        suscriptores.get(repartidorId)!.add(ws)
        const ultima = ubicaciones.get(repartidorId)
        if (ultima) ws.send(JSON.stringify({ ...ultima, ts: Date.now() }))
        ws.on("close", () => {
          suscriptores.get(repartidorId)?.delete(ws)
          if (suscriptores.get(repartidorId)?.size === 0) suscriptores.delete(repartidorId)
        })
      }
    }

    // ── Ruta pedidos ─────────────────────────────────────────────────────────
    else if (path === "/ws/pedidos") {
      const userId = url.searchParams.get("userId") || ""
      if (!userId) { ws.close(1008, "userId requerido"); return }

      if (!token) { ws.close(1008, "token requerido"); return }
      const authUserId = await verifyTokenAny(token)
      if (!authUserId || authUserId !== userId) { ws.close(1008, "No autorizado"); return }

      if (!pedidoClientes.has(userId)) pedidoClientes.set(userId, new Set())
      pedidoClientes.get(userId)!.add(ws)

      ws.on("close", async () => {
        pedidoClientes.get(userId)?.delete(ws)
        if (pedidoClientes.get(userId)?.size === 0) {
          pedidoClientes.delete(userId)
          try {
            const [rep] = await sql`
              SELECT id, COALESCE(usuario_id, id) as user_id 
              FROM repartidores 
              WHERE (id = ${userId} OR usuario_id = ${userId}) 
                AND (status = 'online' OR en_linea = true)
            `
            if (rep) {
              const [activo] = await sql`
                SELECT 1 FROM pedidos 
                WHERE repartidor_id = ${rep.id} 
                  AND status IN ('asignado', 'preparando', 'listo', 'en_camino', 'esperando_cliente')
                LIMIT 1
              `
              if (!activo) {
                await sql`
                  UPDATE repartidores 
                  SET status = 'offline', en_linea = false, disponible = false, ultima_actividad = NOW()
                  WHERE id = ${rep.id}
                `
                console.log(`[ws:close] Repartidor ${rep.id} desconectado automáticamente al cerrar conexión`)
                const targetUid = rep.user_id || rep.id
                sendPushToUser(
                  sql,
                  targetUid,
                  "🛵 Ya Voy Repartidor",
                  "Te has desconectado automáticamente al cerrar la app. Abre la app cuando estés listo para recibir pedidos.",
                  { tipo: "desconexion_inactividad" }
                ).catch(() => {})
              }
            }
          } catch (e: any) {
            console.error("[ws:close:repartidor]", e.message)
          }
        }
      })
    }

    ws.on("error", () => {})
  })

  console.log("WebSocket iniciado en /ws/ubicacion y /ws/pedidos")
}
