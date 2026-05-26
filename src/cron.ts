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

  console.log("✅ Cron jobs iniciados")
}