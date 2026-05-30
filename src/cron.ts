import cron from "node-cron"
import { sql } from "./db"

export function initCronJobs() {
  // Cada dia a las 3am — limpiar pedidos viejos
  cron.schedule("0 3 * * *", async () => {
    try {
      const r1 = await sql`
        DELETE FROM pedidos
        WHERE status IN ('entregado','cancelado')
        AND actualizado_en < NOW() - INTERVAL '90 days'
        RETURNING id`
      console.log(`🧹 Cron: ${r1.length} pedidos viejos eliminados`)

      const r2 = await sql`
        DELETE FROM device_tokens
        WHERE updated_at < NOW() - INTERVAL '60 days'
        RETURNING user_id`
      console.log(`🧹 Cron: ${r2.length} tokens viejos eliminados`)
    } catch(e: any) {
      console.error("Cron error:", e.message)
    }
  })

  // Cada 5 min — auto-cancelar pedidos que el restaurante no atendió en 30 min
  cron.schedule("*/5 * * * *", async () => {
    try {
      // Pedidos en status 'nuevo' hace más de 30 min sin actualizar
      const viejos = await sql`
        SELECT p.*, v.id as vid, v.incidentes_count FROM pedidos p
        LEFT JOIN viveres v ON v.id = p.negocio_id
        WHERE p.status = 'nuevo'
        AND p.creado_en < NOW() - INTERVAL '30 minutes'`

      for (const p of viejos) {
        // Cancelar pedido
        await sql`UPDATE pedidos SET status = 'cancelado', cancelado_en = NOW() WHERE id = ${p.id}`

        // Incrementar contador de incidentes del restaurante
        const nuevos = (Number(p.incidentes_count) || 0) + 1
        if (nuevos >= 3) {
          // Suspender restaurante automáticamente
          await sql`UPDATE viveres SET incidentes_count = ${nuevos}, suspendido = true, bloqueado = true, razon_bloqueo = '3 pedidos abandonados — suspendido automaticamente' WHERE id = ${p.negocio_id}`
          await sql`INSERT INTO bloqueos_historial (tipo_usuario, actor_id, razon)
            VALUES ('negocio', ${p.negocio_id}, '3+ pedidos abandonados — suspension automatica')`.catch(() => {})
          console.log(`⚠️ Restaurante ${p.negocio_id} suspendido por 3 incidentes`)
        } else {
          await sql`UPDATE viveres SET incidentes_count = ${nuevos} WHERE id = ${p.negocio_id}`
        }

        console.log(`🚫 Pedido ${p.id} auto-cancelado por inactividad restaurante (incidente ${nuevos})`)
      }
    } catch(e: any) {
      console.error("Cron auto-cancel error:", e.message)
    }
  })

  console.log("✅ Cron jobs iniciados")
}
