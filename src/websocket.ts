import { WebSocketServer, WebSocket } from "ws"
import { IncomingMessage } from "http"
import { Server } from "http"

// Map: repartidorId -> Set de clientes suscritos
const suscriptores = new Map<string, Set<WebSocket>>()
// Map: repartidorId -> ultima ubicacion conocida
const ubicaciones = new Map<string, { lat: number; lng: number }>()

export function initWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws/ubicacion" })

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // URL: /ws/ubicacion?repartidorId=xxx&rol=cliente|repartidor
    const url = new URL(req.url || "", "http://localhost")
    const repartidorId = url.searchParams.get("repartidorId") || ""
    const rol = url.searchParams.get("rol") || "cliente"

    if (!repartidorId) { ws.close(1008, "repartidorId requerido"); return }

    if (rol === "repartidor") {
      // El repartidor envia su ubicacion
      ws.on("message", (data) => {
        try {
          const { lat, lng } = JSON.parse(data.toString())
          if (!lat || !lng) return
          ubicaciones.set(repartidorId, { lat, lng })
          // Broadcast a todos los clientes suscritos a este repartidor
          const clientes = suscriptores.get(repartidorId)
          if (clientes) {
            const msg = JSON.stringify({ lat, lng, ts: Date.now() })
            clientes.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg) })
          }
        } catch {}
      })
      ws.on("close", () => {
        ubicaciones.delete(repartidorId)
      })
    } else {
      // Cliente suscribiendose a ubicacion del repartidor
      if (!suscriptores.has(repartidorId)) suscriptores.set(repartidorId, new Set())
      suscriptores.get(repartidorId)!.add(ws)
      // Enviar ultima ubicacion conocida inmediatamente
      const ultima = ubicaciones.get(repartidorId)
      if (ultima) ws.send(JSON.stringify({ ...ultima, ts: Date.now() }))

      ws.on("close", () => {
        suscriptores.get(repartidorId)?.delete(ws)
        if (suscriptores.get(repartidorId)?.size === 0) suscriptores.delete(repartidorId)
      })
    }

    ws.on("error", () => {})
  })

  console.log("WebSocket ubicacion iniciado en /ws/ubicacion")
}
