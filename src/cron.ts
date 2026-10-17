import { sql } from "./db"
import { sendPushToUser } from "./firebase"
import { notificarCliente } from "./websocket"
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
        SET foto_entrega_url = NULL, foto_entrega = NULL, foto_entrega_expira = NULL
        WHERE foto_entrega_expira IS NOT NULL AND foto_entrega_expira < NOW()
      `
      if (result.length > 0)
        console.log(`[cron] Fotos de entrega expiradas eliminadas: ${result.length}`)
    } catch (e: any) {
      console.error("[cron:fotos]", e.message)
    }
  }, 60 * 60 * 1000)

  // ── 2. Gestión automática de pedidos (sin respuesta, sin repartidor, o repartidor inactivo) — cada 2 min ─
  setInterval(async () => {
    try {
      // 2A. Auto-cancelar pedidos en "nuevo" donde el restaurante no respondió en 20 minutos
      const sinRespuestaRest = await sql`
        UPDATE pedidos
        SET status = 'cancelado',
            cancelado_en = NOW(),
            compensar_restaurante = false,
            razon_cancelacion = 'Cancelado automáticamente: el restaurante no respondió en 20 minutos'
        WHERE status = 'nuevo'
          AND creado_en < NOW() - INTERVAL '20 minutes'
        RETURNING *
      `
      for (const p of sinRespuestaRest) {
        if (p.metodo_pago === "tarjeta" && Number(p.total) > 0 && p.cliente_id) {
          await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance, 0) + ${Number(p.total)} WHERE id = ${p.cliente_id}`.catch(() => {})
          await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto, pedido_id) VALUES (${p.cliente_id}, 'credito', ${Number(p.total)}, 'Reembolso automático: restaurante no respondió', ${String(p.id)})`.catch(() => {})
        }
        if (p.cliente_id) {
          notificarCliente(p.cliente_id, "pedido_update", p)
          sendPushToUser(
            sql, p.cliente_id,
            "Pedido cancelado 😔",
            "El restaurante no respondió a tiempo. Si realizaste pago digital, se reembolsó íntegro a tu saldo.",
            { pedidoId: String(p.id), status: "cancelado" }
          ).catch(() => {})
        }
      }

      // 2B. Si un repartidor aceptó el pedido pero lleva más de 20 min sin recogerlo en el restaurante, liberarlo para otros repartidores
      const repInactivos = await sql`
        UPDATE pedidos
        SET repartidor_id = NULL,
            asignado_en = NULL,
            actualizado_en = NOW()
        WHERE status IN ('preparando', 'listo')
          AND repartidor_id IS NOT NULL AND repartidor_id != ''
          AND COALESCE(verificado_restaurante, false) = false
          AND COALESCE(asignado_en, actualizado_en) < NOW() - INTERVAL '20 minutes'
        RETURNING id, negocio_id, cliente_id
      `
      for (const p of repInactivos) {
        const repartidoresOnline = await sql`SELECT id FROM repartidores WHERE status = 'online' OR en_linea = true`.catch(() => [])
        for (const r of repartidoresOnline) {
          notificarCliente(r.id, "pedido_disponible", { id: p.id })
          sendPushToUser(sql, r.id, "🛵 Pedido urgente disponible", "Un pedido listo necesita repartidor cercano.", { pedidoId: String(p.id), tipo: "pedido_disponible" }).catch(() => {})
        }
      }

      // 2C. Si ningún repartidor acepta el pedido tras 25 minutos en 'preparando' o 'listo':
      //     Se cancela automáticamente SIN AFECTAR AL RESTAURANTE (compensar_restaurante = true) y reembolsando al cliente.
      const sinRepartidor = await sql`
        UPDATE pedidos
        SET status = 'cancelado',
            cancelado_en = NOW(),
            compensar_restaurante = true,
            razon_cancelacion = 'Cancelado automáticamente: ningún repartidor disponible aceptó el pedido en 25 minutos (pago de platillos protegido para el restaurante)'
        WHERE status IN ('preparando', 'listo')
          AND (repartidor_id IS NULL OR repartidor_id = '')
          AND creado_en < NOW() - INTERVAL '25 minutes'
        RETURNING *
      `
      for (const p of sinRepartidor) {
        // Reembolsar al cliente si pagó con tarjeta
        if (p.metodo_pago === "tarjeta" && Number(p.total) > 0 && p.cliente_id) {
          await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance, 0) + ${Number(p.total)} WHERE id = ${p.cliente_id}`.catch(() => {})
          await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto, pedido_id) VALUES (${p.cliente_id}, 'credito', ${Number(p.total)}, 'Reembolso automático: sin repartidores disponibles', ${String(p.id)})`.catch(() => {})
        }
        // Registrar compensación al restaurante en fondo_recuperacion
        const subtotalRest = Math.max(0, Number(p.total || 0) - Number(p.costo_envio || 25) - Number(p.propina || 0))
        if (subtotalRest > 0) {
          await sql`
            INSERT INTO fondo_recuperacion (tipo, monto, descripcion, pedido_id, aprobado_por)
            VALUES ('egreso', ${subtotalRest}, 'Compensación automática a restaurante por falta de repartidores', ${String(p.id)}, 'sistema')
          `.catch(() => {})
        }
        if (p.cliente_id) {
          notificarCliente(p.cliente_id, "pedido_update", p)
          sendPushToUser(
            sql, p.cliente_id,
            "Pedido cancelado por falta de repartidores 😔",
            "Ningún repartidor cercano pudo tomar tu pedido a tiempo. Tu dinero ha sido reembolsado.",
            { pedidoId: String(p.id), status: "cancelado" }
          ).catch(() => {})
        }
        if (p.negocio_id) {
          const neg = await sql`SELECT COALESCE(owner_id, user_id) as owner_id FROM viveres WHERE id = ${p.negocio_id}`.catch(() => [])
          if (neg[0]?.owner_id) {
            notificarCliente(neg[0].owner_id, "pedido_update", p)
            sendPushToUser(
              sql, neg[0].owner_id,
              "⚠️ Pedido cancelado sin repartidor (Ganancia protegida)",
              "Ningún repartidor aceptó el pedido en 25 min. El pedido fue cancelado sin afectar tus ganancias.",
              { pedidoId: String(p.id), status: "cancelado" }
            ).catch(() => {})
          }
        }
      }
    } catch (e: any) {
      console.error("[cron:autocancel]", e.message)
    }
  }, 2 * 60 * 1000)

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

  console.log("Cron jobs iniciados (horarios MX, fotos, auto-cancelación inteligente, limpieza de tokens)")
}
