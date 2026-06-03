import cron from "node-cron"
import { sql } from "./db"
import { sendPushToUser } from "./firebase"
import { notificarCliente } from "./websocket"

const CLOUDINARY_CLOUD = process.env.CLOUDINARY_CLOUD_NAME
if (!CLOUDINARY_CLOUD) throw new Error("CLOUDINARY_CLOUD_NAME no definido en variables de entorno")
const CLOUDINARY_KEY   = process.env.CLOUDINARY_API_KEY || ""
const CLOUDINARY_SECRET = process.env.CLOUDINARY_API_SECRET || ""

async function deleteCloudinaryImage(url: string) {
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/)
    if (!match) return
    const publicId = match[1]
    const timestamp = Math.floor(Date.now() / 1000)
    const crypto = await import("crypto")
    const signature = crypto.createHash("sha1")
      .update("public_id=" + publicId + "&timestamp=" + timestamp + CLOUDINARY_SECRET)
      .digest("hex")
    await fetch("https://api.cloudinary.com/v1_1/" + CLOUDINARY_CLOUD + "/image/destroy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_id: publicId, timestamp, api_key: CLOUDINARY_KEY, signature })
    })
  } catch (e: any) {
    console.error("Error borrando foto Cloudinary:", e.message)
  }
}

export function initCronJobs() {
  // Cada dia a las 3am — limpiar pedidos viejos
  cron.schedule("0 3 * * *", async () => {
    try {
      const r1 = await sql`
        DELETE FROM pedidos
        WHERE status IN ('entregado','cancelado')
        AND actualizado_en < NOW() - INTERVAL '90 days'
        RETURNING id`
      console.log("Cron: " + r1.length + " pedidos viejos eliminados")

      const r2 = await sql`
        DELETE FROM device_tokens
        WHERE updated_at < NOW() - INTERVAL '60 days'
        RETURNING user_id`
      console.log("Cron: " + r2.length + " tokens viejos eliminados")
      const r3 = await sql`
        DELETE FROM mensajes
        WHERE creado_en < NOW() - INTERVAL '90 days'
        RETURNING id`
      console.log("Cron: " + r3.length + " mensajes viejos eliminados")

      const r4 = await sql`
        DELETE FROM contingencias
        WHERE status = 'resuelto'
        AND resuelto_en < NOW() - INTERVAL '90 days'
        RETURNING id`
      console.log("Cron: " + r4.length + " contingencias viejas eliminadas")

      const r5 = await sql`
        DELETE FROM retiros
        WHERE status = 'pagado'
        AND fecha_pago < NOW() - INTERVAL '90 days'
        RETURNING id`
      console.log("Cron: " + r5.length + " retiros viejos eliminados")

      const r6 = await sql`
        DELETE FROM reportes_soporte
        WHERE status = 'resuelto'
        AND resuelto_en < NOW() - INTERVAL '90 days'
        RETURNING id`
      console.log("Cron: " + r6.length + " reportes viejos eliminados")
    } catch(e: any) {
      console.error("Cron error:", e.message)
    }
  })

  // Cada 5 min — auto-cancelar pedidos que el restaurante no atendio en 30 min
  cron.schedule("*/5 * * * *", async () => {
    try {
      const viejos = await sql`
        SELECT p.*, v.id as vid, v.incidentes_count FROM pedidos p
        LEFT JOIN viveres v ON v.id = p.negocio_id
        WHERE p.status = 'nuevo'
        AND p.creado_en < NOW() - INTERVAL '30 minutes'`

      for (const p of viejos) {
        await sql`UPDATE pedidos SET status = 'cancelado', cancelado_en = NOW() WHERE id = ${p.id}`
        notificarCliente(p.cliente_id, "pedido_update", { id: p.id, status: "cancelado" })
        await sendPushToUser(sql, p.cliente_id, "Tu pedido fue cancelado", "El restaurante no respondio tu pedido a tiempo. Intenta de nuevo.", { tipo: "pedido_cancelado", pedido_id: String(p.id) }).catch(() => {})
        const nuevos = (Number(p.incidentes_count) || 0) + 1
        if (nuevos >= 3) {
          await sql`UPDATE viveres SET incidentes_count = ${nuevos}, suspendido = true, bloqueado = true, razon_bloqueo = '3 pedidos abandonados — suspendido automaticamente' WHERE id = ${p.negocio_id}`
          await sql`INSERT INTO bloqueos_historial (tipo_usuario, actor_id, razon)
            VALUES ('negocio', ${p.negocio_id}, '3+ pedidos abandonados — suspension automatica')`.catch(() => {})
          console.log("Restaurante " + p.negocio_id + " suspendido por 3 incidentes")
        } else {
          await sql`UPDATE viveres SET incidentes_count = ${nuevos} WHERE id = ${p.negocio_id}`
        }
        console.log("Pedido " + p.id + " auto-cancelado (incidente " + nuevos + ")")
      }
    } catch(e: any) {
      console.error("Cron auto-cancel error:", e.message)
    }
  })

  // Cada hora — limpiar fotos de entrega vencidas (mas de 24h desde entregado_en)
  cron.schedule("0 * * * *", async () => {
    try {
      const vencidos = await sql`
        SELECT id, foto_entrega FROM pedidos
        WHERE foto_entrega IS NOT NULL
        AND foto_entrega != ''
        AND entregado_en IS NOT NULL
        AND entregado_en < NOW() - INTERVAL '24 hours'`

      for (const p of vencidos) {
        await deleteCloudinaryImage(p.foto_entrega)
        await sql`UPDATE pedidos SET foto_entrega = NULL WHERE id = ${p.id}`
        console.log("Foto entrega eliminada para pedido " + p.id)
      }
      if (vencidos.length > 0) console.log("Cron fotos: " + vencidos.length + " fotos eliminadas")
    } catch(e: any) {
      console.error("Cron fotos error:", e.message)
    }
  })

  console.log("Cron jobs iniciados")
}
