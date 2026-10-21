import { sql } from "./db"
import { sendPushToUser } from "./firebase"
import { notificarCliente } from "./websocket"
import { getMexicoNow, sincronizarEstadoNegocio } from "./utils/horarios"
import { deleteSupabaseStorageFile } from "./services/solicitudesService"
import { sendTelegramAdmin, escapeHtml } from "./notificationsAdmin"

const alertadosSinRepartidor = new Set<string>()

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

  // ── 1. Eliminar físicamente de Supabase Storage las fotos de entrega vencidas (>24h) — cada hora ──
  setInterval(async () => {
    try {
      const vencidas = await sql`
        SELECT id, foto_entrega, foto_entrega_url
        FROM pedidos
        WHERE foto_entrega_expira IS NOT NULL AND foto_entrega_expira < NOW()
      `
      for (const p of vencidas) {
        const urls = new Set([p.foto_entrega, p.foto_entrega_url].filter(Boolean))
        for (const u of urls) {
          await deleteSupabaseStorageFile(String(u)).catch(() => {})
        }
      }
      if (vencidas.length > 0) {
        await sql`
          UPDATE pedidos
          SET foto_entrega_url = NULL, foto_entrega = NULL, foto_entrega_expira = NULL
          WHERE foto_entrega_expira IS NOT NULL AND foto_entrega_expira < NOW()
        `
        console.log(`[cron] Fotos de entrega expiradas eliminadas físicamente de Storage: ${vencidas.length}`)
      }
    } catch (e: any) {
      console.error("[cron:fotos]", e.message)
    }
  }, 60 * 60 * 1000)

  // ── 2. Gestión automática de pedidos (programados, borradores, sin respuesta, sin repartidor, alertas Admin) — cada 2 min ─
  setInterval(async () => {
    try {
      // 2.0 Limpiar borradores 'pendiente_pago' abandonados hace más de 30 minutos
      const borradoresVencidos = await sql`
        DELETE FROM pedidos
        WHERE status = 'pendiente_pago'
          AND creado_en < NOW() - INTERVAL '30 minutes'
        RETURNING id, cliente_id, wallet_monto, cupon_codigo
      `.catch(() => [])
      for (const b of borradoresVencidos) {
        if (b.wallet_monto && Number(b.wallet_monto) > 0 && b.cliente_id) {
          await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance, 0) + ${Number(b.wallet_monto)} WHERE id = ${b.cliente_id}`.catch(() => {})
          await sql`DELETE FROM wallet_movimientos WHERE pedido_id = ${String(b.id)}`.catch(() => {})
        }
        if (b.cupon_codigo) {
          await sql`UPDATE cupones SET usos_actual = GREATEST(0, COALESCE(usos_actual, 1) - 1) WHERE codigo = ${b.cupon_codigo}`.catch(() => {})
        }
      }

      // 2.0B Activar pedidos 'programado' cuando faltan <= 30 minutos para su hora programada
      const programadosListos = await sql`
        UPDATE pedidos
        SET status = 'nuevo', actualizado_en = NOW()
        WHERE status = 'programado'
          AND programado_para IS NOT NULL
          AND programado_para <= NOW() + INTERVAL '30 minutes'
        RETURNING *
      `.catch(() => [])
      for (const p of programadosListos) {
        if (p.negocio_id) {
          const neg = await sql`SELECT COALESCE(owner_id, user_id) as owner_id FROM viveres WHERE id = ${p.negocio_id}`.catch(() => [])
          if (neg[0]?.owner_id) {
            notificarCliente(neg[0].owner_id, "nuevo_pedido", p)
            notificarCliente(neg[0].owner_id, "pedido_update", p)
            sendPushToUser(
              sql,
              neg[0].owner_id,
              "📅 ¡Hora de preparar pedido programado!",
              `El pedido programado por $${Number(p.total || 0).toFixed(2)} ya entró a cocina.`,
              { pedidoId: String(p.id), status: "nuevo", tipo: "nuevo_pedido" }
            ).catch(() => {})
          }
        }
      }

      // 2A. Auto-cancelar pedidos en "nuevo" donde el restaurante no respondió en 20 minutos (excluyendo programados futuros)
      const sinRespuestaRest = await sql`
        UPDATE pedidos
        SET status = 'cancelado',
            cancelado_en = NOW(),
            compensar_restaurante = false,
            razon_cancelacion = 'Cancelado automáticamente: el restaurante no respondió en 20 minutos'
        WHERE status = 'nuevo'
          AND (programado_para IS NULL OR programado_para <= NOW() + INTERVAL '10 minutes')
          AND actualizado_en < NOW() - INTERVAL '20 minutes'
        RETURNING *
      `
      for (const p of sinRespuestaRest) {
        if ((p.metodo_pago === "tarjeta" || Number(p.wallet_monto) > 0) && Number(p.total) > 0 && p.cliente_id) {
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
        const repartidoresOnline = await sql`SELECT id FROM repartidores WHERE (status = 'online' OR en_linea = true) AND COALESCE(bloqueado, false) = false`.catch(() => [])
        for (const r of repartidoresOnline) {
          notificarCliente(r.id, "pedido_disponible", { id: p.id })
          sendPushToUser(sql, r.id, "🛵 Pedido urgente disponible", "Un pedido listo necesita repartidor cercano.", { pedidoId: String(p.id), tipo: "pedido_disponible" }).catch(() => {})
        }
      }

      
      // 2C. Auto-desconectar repartidores inactivos (sin actualizacion GPS por mas de 10 min y sin pedidos activos)
      const inactivosRepartidores = await sql`
        SELECT id FROM repartidores
        WHERE (status = 'online' OR en_linea = true)
          AND (ultima_actividad IS NULL OR ultima_actividad < NOW() - INTERVAL '10 minutes')
          AND id NOT IN (
            SELECT DISTINCT repartidor_id FROM pedidos 
            WHERE status IN ('preparando', 'listo', 'en_camino', 'esperando_cliente')
              AND repartidor_id IS NOT NULL
          )
      `.catch(() => []);

      if (inactivosRepartidores && inactivosRepartidores.length > 0) {
        const inactivosIds = inactivosRepartidores.map((r: any) => r.id);
        await sql`
          UPDATE repartidores
          SET status = 'offline', en_linea = false, disponible = false
          WHERE id IN ${sql(inactivosIds)}
        `.catch(() => {});

        for (const r of inactivosRepartidores) {
          try {
            notificarCliente(r.id, "desconexion_inactividad", { en_linea: false });
            sendPushToUser(
              sql,
              r.id,
              "🛵 Ya Voy Repartidor",
              "Te has desconectado automáticamente por inactividad. Abre la app cuando estés listo para recibir pedidos.",
              { tipo: "desconexion_inactividad" }
            ).catch(() => {});
          } catch {}
        }
      }

      // 2B-Alerta: Avisar al Admin en Telegram si un pedido a domicilio lleva más de 10 minutos en 'listo' o 'preparando' sin repartidor
      const demoradosSinRep = await sql`
        SELECT p.id, p.total, p.costo_envio, v.nombre as negocio_nombre
        FROM pedidos p
        LEFT JOIN viveres v ON v.id = p.negocio_id
        WHERE p.status IN ('preparando', 'listo')
          AND (p.repartidor_id IS NULL OR p.repartidor_id = '')
          AND COALESCE(p.tipo_entrega, 'domicilio') != 'pickup'
          AND p.creado_en < NOW() - INTERVAL '10 minutes'
          AND p.creado_en > NOW() - INTERVAL '24 minutes'
      `.catch(() => [])
      for (const d of demoradosSinRep) {
        const pid = String(d.id)
        if (!alertadosSinRepartidor.has(pid)) {
          alertadosSinRepartidor.add(pid)
          sendTelegramAdmin(
            `⏳ <b>ALERTA LOGÍSTICA: Pedido sin repartidor (+10 min)</b>\n\n` +
            `📦 <b>Pedido:</b> <code>#${escapeHtml(pid.slice(-6).toUpperCase())}</code>\n` +
            `🏪 <b>Restaurante:</b> ${escapeHtml(d.negocio_nombre || "Local")}\n` +
            `💵 <b>Total:</b> $${Number(d.total || 0).toFixed(2)} MXN (Envío: $${Number(d.costo_envio || 25).toFixed(0)})\n\n` +
            `<i>Si ningún repartidor lo acepta a los 25 minutos, el sistema lo cancelará protegiendo al restaurante.</i>`,
            "HTML"
          ).catch(() => {})
        }
      }

      // 2C. Si ningún repartidor acepta un pedido a domicilio tras 25 minutos en 'preparando' o 'listo':
      //     Se cancela automáticamente SIN AFECTAR AL RESTAURANTE (compensar_restaurante = true) y reembolsando al cliente.
      const sinRepartidor = await sql`
        UPDATE pedidos
        SET status = 'cancelado',
            cancelado_en = NOW(),
            compensar_restaurante = true,
            razon_cancelacion = 'Cancelado automáticamente: ningún repartidor disponible aceptó el pedido en 25 minutos (pago de platillos protegido para el restaurante)'
        WHERE status IN ('preparando', 'listo')
          AND (repartidor_id IS NULL OR repartidor_id = '')
          AND COALESCE(tipo_entrega, 'domicilio') != 'pickup'
          AND creado_en < NOW() - INTERVAL '25 minutes'
        RETURNING *
      `
      for (const p of sinRepartidor) {
        alertadosSinRepartidor.delete(String(p.id))
        // Reembolsar al cliente si pagó con tarjeta o wallet
        if ((p.metodo_pago === "tarjeta" || Number(p.wallet_monto) > 0) && Number(p.total) > 0 && p.cliente_id) {
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

  // ── 4. Auto-desconexión de repartidores inactivos (>5 min sin actividad ni pedidos en curso) ──
  setInterval(async () => {
    try {
      const inactivos = await sql`
        UPDATE repartidores
        SET status = 'offline', en_linea = false, disponible = false
        WHERE (status = 'online' OR en_linea = true)
          AND (ultima_actividad IS NULL OR ultima_actividad < NOW() - INTERVAL '5 minutes')
          AND id NOT IN (
            SELECT DISTINCT repartidor_id FROM pedidos 
            WHERE status IN ('asignado', 'preparando', 'listo', 'en_camino', 'esperando_cliente')
              AND repartidor_id IS NOT NULL
          )
        RETURNING id, COALESCE(usuario_id, id) as user_id
      `
      for (const rep of inactivos) {
        const uids = Array.from(new Set([rep.id, rep.user_id].filter(Boolean)))
        for (const uid of uids) {
          notificarCliente(uid, "repartidor_status", { en_linea: false, status: "offline" })
          sendPushToUser(
            sql,
            uid,
            "🛵 Ya Voy Repartidor",
            "Te has desconectado automáticamente por inactividad. Abre la app cuando estés listo para recibir pedidos.",
            { tipo: "desconexion_inactividad" }
          ).catch(() => {})
        }
      }
      if (inactivos.length > 0) {
        console.log(`[cron:repartidores] Repartidores desconectados por inactividad: ${inactivos.length}`)
      }
    } catch (e: any) {
      console.error("[cron:repartidor_inactivos]", e.message)
    }
  }, 60 * 1000)

  console.log("Cron jobs iniciados (horarios MX, fotos Storage, programados, auto-cancelación inteligente, auto-desconexión repartidores, alertas Admin)")
}

