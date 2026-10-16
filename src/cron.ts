import { sql } from "./db"
import { sendPushToUser } from "./firebase"
import { getMexicoNow, sincronizarEstadoNegocio } from "./utils/horarios"

export function initCronJobs() {
  // ── 0. Sincronizar horarios de restaurantes (y reabrir al día siguiente tras cierre manual) cada 2 minutos ──
  const syncHorariosRestaurantes = async () => {
    try {
      const mx = getMexicoNow()
      const negocios = await sql`
        SELECT id, horarios, esta_abierto, cierre_manual_fecha, apertura_manual_fecha
        FROM viveres
        WHERE COALESCE(status, 'aprobado') = 'aprobado'
      `
      for (const neg of negocios) {
        await sincronizarEstadoNegocio(neg, mx)
      }
    } catch (e: any) {
      console.error("[cron:horarios]", e.message)
    }
  }
  syncHorariosRestaurantes().catch(() => {})
  setInterval(syncHorariosRestaurantes, 2 * 60 * 1000)

  // ── 1. Limpiar fotos de entrega vencidas — cada hora ────────────────────────
  setInterval(async () => {
    try {
      const result = await sql`
        UPDATE pedidos
        SET foto_entrega_url = NULL, foto_entrega_expira = NULL
        WHERE foto_entrega_expira IS NOT NULL AND foto_entrega_expira < NOW()
      `
      if (result.length > 0)
        console.log(`[cron] Fotos de entrega expiradas eliminadas: ${result.length}`)
    } catch (e: any) {
      console.error("[cron:fotos]", e.message)
    }
  }, 60 * 60 * 1000)

  // ── 2. Auto-cancelar pedidos en "nuevo" sin respuesta > 30 min — cada 5 min ─
  setInterval(async () => {
    try {
      const vencidos = await sql`
        UPDATE pedidos
        SET status = 'cancelado', cancelado_en = NOW(),
            razon_cancelacion = 'Cancelado automáticamente: el restaurante no respondió en 30 minutos'
        WHERE status = 'nuevo'
          AND creado_en < NOW() - INTERVAL '30 minutes'
        RETURNING id, cliente_id, negocio_id
      `
      for (const p of vencidos) {
        sendPushToUser(
          sql, p.cliente_id,
          "Pedido cancelado 😔",
          "El restaurante no respondió a tiempo. No se realizó ningún cargo.",
          { pedidoId: p.id, status: "cancelado" }
        ).catch(() => {})
      }
      if (vencidos.length > 0)
        console.log(`[cron] Pedidos auto-cancelados por inactividad: ${vencidos.length}`)
    } catch (e: any) {
      console.error("[cron:autocancel]", e.message)
    }
  }, 5 * 60 * 1000)

  // ── 3. Limpiar tokens FCM obsoletos (> 90 días sin actualizar) — cada 24h ───
  setInterval(async () => {
    try {
      await sql`
        DELETE FROM device_tokens
        WHERE updated_at < NOW() - INTERVAL '90 days'
      `
    } catch (e: any) {
      console.error("[cron:tokens]", e.message)
    }
  }, 24 * 60 * 60 * 1000)

  console.log("Cron jobs iniciados (horarios MX, fotos, auto-cancelación, limpieza de tokens)")
}
