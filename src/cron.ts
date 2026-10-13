import cron from "node-cron"
import { sql } from "./db"
import { sendPushToUser } from "./firebase"
import { notificarCliente } from "./websocket"
import { logError } from "./logger"
import { purgeSolicitudSensitiveDocs } from "./services/solicitudesService"

async function deleteCloudinaryImage(url: string) {
  const CLOUDINARY_CLOUD = process.env.CLOUDINARY_CLOUD_NAME
  const CLOUDINARY_KEY   = process.env.CLOUDINARY_API_KEY || ""
  const CLOUDINARY_SECRET = process.env.CLOUDINARY_API_SECRET || ""
  if (!CLOUDINARY_CLOUD) return
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

      const r7 = await sql`
        DELETE FROM bloqueos_historial
        WHERE creado_en < NOW() - INTERVAL '365 days'
        RETURNING id`
      console.log("Cron: " + r7.length + " bloqueos viejos eliminados")

      const r8 = await sql`
        DELETE FROM solicitudes
        WHERE status = 'rechazado'
        AND actualizado_en < NOW() - INTERVAL '30 days'
        RETURNING id`
      console.log("Cron: " + r8.length + " solicitudes rechazadas eliminadas")

      const r9 = await sql`
        DELETE FROM mensajes
        WHERE pedido_id NOT IN (SELECT id FROM pedidos)
        RETURNING id`
      console.log("Cron: " + r9.length + " mensajes huerfanos eliminados")

      // Purgar documentos sensibles de solicitudes pendientes mayores a 14 días o ya aprobadas/rechazadas que aún tengan documentos
      try {
        const docsOld = await sql`
          SELECT id FROM solicitudes 
          WHERE (status IN ('aprobado', 'rechazado') OR creado_en < NOW() - INTERVAL '14 days')
          AND documentos->>'ine_frente' IS NOT NULL
          AND documentos->>'ine_frente' NOT LIKE '%ELIMINADO%'
          LIMIT 50
        `
        for (const row of docsOld) {
          await purgeSolicitudSensitiveDocs(row.id).catch(() => {})
        }
        if (docsOld.length > 0) {
          console.log(`Cron: ${docsOld.length} solicitudes con documentos sensibles purgados por privacidad`)
        }
      } catch (err: any) {
        console.warn("Cron error purgando documentos sensibles:", err.message)
      }

      await sql`ANALYZE pedidos, mensajes, device_tokens, retiros, reportes_soporte, bloqueos_historial, solicitudes`
      console.log("Cron: ANALYZE completado")
    } catch(e: any) {
      console.error("Cron error:", e.message)
    }
  })

  // Cada 5 min — recordatorio de calificación 10-15min después de entregado
  cron.schedule("*/5 * * * *", async () => {
    try {
      const sinRating = await sql`
        SELECT id, cliente_id, negocio_id FROM pedidos
        WHERE status = 'entregado'
          AND rating_restaurante IS NULL
          AND entregado_en > NOW() - INTERVAL '15 minutes'
          AND entregado_en < NOW() - INTERVAL '10 minutes'`
      for (const p of sinRating) {
        await sendPushToUser(sql, p.cliente_id,
          "¿Cómo estuvo tu pedido?",
          "Cuéntanos tu experiencia — solo toma 5 segundos.",
          { tipo: "rating_reminder", pedidoId: String(p.id) }
        ).catch(e => logError(e, "cron:push_rating"))
      }
    } catch(e: any) { console.error("Cron rating reminder:", e.message) }
  })

  // Cada 5 min — auto-cancelar pedidos pendiente_pago > 30min (pago abandonado)
  cron.schedule("*/5 * * * *", async () => {
    try {
      const abandonados = await sql`
        SELECT id, cliente_id FROM pedidos
        WHERE status = 'pendiente_pago'
        AND creado_en < NOW() - INTERVAL '30 minutes'`
      for (const p of abandonados) {
        await sql`UPDATE pedidos SET status = 'cancelado', cancelado_en = NOW() WHERE id = ${p.id}`
        if (p.cliente_id) {
          await sendPushToUser(sql, p.cliente_id, "Pago no completado", "Tu pedido fue cancelado porque el pago no se completó a tiempo.", { tipo: "pago_expirado", pedidoId: String(p.id) }).catch(e => logError(e, "cron:push_pago_expirado"))
        }
        console.log("Pedido " + p.id + " cancelado (pago abandonado)")
      }
    } catch(e: any) { console.error("Cron pendiente_pago:", e.message) }
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
        await sendPushToUser(sql, p.cliente_id, "Tu pedido fue cancelado", "El restaurante no respondio tu pedido a tiempo. Intenta de nuevo.", { tipo: "pedido_cancelado", pedido_id: String(p.id) }).catch(e => logError(e, "cron:push_cancelado"))
        const nuevos = (Number(p.incidentes_count) || 0) + 1
        if (nuevos >= 3) {
          await sql`UPDATE viveres SET incidentes_count = ${nuevos}, suspendido = true, bloqueado = true, razon_bloqueo = '3 pedidos abandonados — suspendido automaticamente' WHERE id = ${p.negocio_id}`
          await sql`INSERT INTO bloqueos_historial (tipo_usuario, actor_id, razon)
            VALUES ('negocio', ${p.negocio_id}, '3+ pedidos abandonados — suspension automatica')`.catch(e => logError(e, "cron:bloqueo_negocio"))
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

  // Cada 10 min — detectar pedidos huérfanos (en_camino sin actualización >45 min)
  cron.schedule("*/10 * * * *", async () => {
    try {
      const huerfanos = await sql`
        SELECT p.id, p.cliente_id, p.repartidor_id, p.negocio_id
        FROM pedidos p
        WHERE p.status = 'en_camino'
        AND p.actualizado_en < NOW() - INTERVAL '45 minutes'`

      for (const p of huerfanos) {
        // Liberar pedido: repartidor_id null, volver a listo para que otro lo tome
        await sql`UPDATE pedidos SET status = 'listo', repartidor_id = NULL, actualizado_en = NOW() WHERE id = ${p.id}`
        notificarCliente(p.cliente_id, "pedido_update", { id: p.id, status: "listo" })
        await sendPushToUser(sql, p.cliente_id,
          "Buscando nuevo repartidor",
          "Tu pedido fue reasignado. En breve un repartidor lo tomará.",
          { tipo: "pedido_reasignado", pedidoId: String(p.id) }
        ).catch(e => logError(e, "cron:push_reasignado"))
        // Penalizar al repartidor que abandonó
        if (p.repartidor_id) {
          await sql`UPDATE repartidores SET status = 'offline', incidentes_abandono = COALESCE(incidentes_abandono, 0) + 1 WHERE id = ${p.repartidor_id}`.catch(e => logError(e, "cron:penalizar_repartidor"))
          await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS incidentes_abandono INT DEFAULT 0`.catch(() => {})
        }
        console.log("Pedido " + p.id + " liberado (repartidor huerfano)")
      }
    } catch(e: any) {
      console.error("Cron huerfanos error:", e.message)
    }
  })

  // Cada hora — limpiar fotos y mensajes de chat de entregas completadas (>24h)
  cron.schedule("0 * * * *", async () => {
    try {
      // Borrar fotos de entrega de Cloudinary
      const vencidos = await sql`
        SELECT id, foto_entrega FROM pedidos
        WHERE foto_entrega IS NOT NULL
        AND foto_entrega != ''
        AND entregado_en IS NOT NULL
        AND entregado_en < NOW() - INTERVAL '24 hours'`

      for (const p of vencidos) {
        await deleteCloudinaryImage(p.foto_entrega)
        await sql`UPDATE pedidos SET foto_entrega = NULL WHERE id = ${p.id}`
      }
      if (vencidos.length > 0) console.log("Cron fotos: " + vencidos.length + " fotos eliminadas")

      // Borrar mensajes de chat de pedidos terminados hace >24h
      const msgs = await sql`
        DELETE FROM mensajes
        WHERE pedido_id IN (
          SELECT id FROM pedidos
          WHERE status IN ('entregado', 'cancelado')
          AND actualizado_en < NOW() - INTERVAL '24 hours'
        )
        RETURNING id`
      if (msgs.length > 0) console.log("Cron mensajes: " + msgs.length + " mensajes eliminados")
    } catch(e: any) {
      console.error("Cron hourly error:", e.message)
    }
  })

  // Cada 5 min — activar pedidos programados cuya franja horaria empezó
  cron.schedule("*/5 * * * *", async () => {
    try {
      const ahora = new Date()
      const horaActual = ahora.getHours() * 60 + ahora.getMinutes()
      const fecha = ahora.toISOString().slice(0, 10)
      const pendientes = await sql`
        SELECT * FROM pedidos
        WHERE status = 'programado'
        AND programado_para IS NOT NULL
        AND programado_para LIKE ${fecha + '%'}`
      for (const p of pendientes) {
        const match = p.programado_para?.match(/(\d{2}):(\d{2})/)
        if (!match) continue
        const franjaMin = parseInt(match[1]) * 60 + parseInt(match[2])
        if (horaActual >= franjaMin) {
          await sql`UPDATE pedidos SET status = 'nuevo' WHERE id = ${p.id}`
          notificarCliente(p.cliente_id, "pedido_update", { ...p, status: "nuevo" })
          if (p.negocio_id) {
            const [neg] = await sql`SELECT owner_id, nombre FROM viveres WHERE id = ${p.negocio_id}`
            if (neg?.owner_id) {
              notificarCliente(neg.owner_id, "nuevo_pedido", { ...p, status: "nuevo" })
              await sendPushToUser(sql, neg.owner_id, "Pedido programado listo", "Tienes un pedido programado activo en " + neg.nombre, { pedidoId: p.id }).catch(() => {})
            }
          }
          console.log("Pedido programado " + p.id + " activado")
        }
      }
    } catch (e: any) { console.error("Cron programados:", e.message) }
  })

  // Cada hora — acreditar puntos a pedidos entregados sin puntos asignados
  cron.schedule("0 * * * *", async () => {
    try {
      const sinPuntos = await sql`
        SELECT p.id, p.cliente_id, p.total
        FROM pedidos p
        WHERE p.status = 'entregado'
        AND p.entregado_en > NOW() - INTERVAL '2 hours'
        AND NOT EXISTS (
          SELECT 1 FROM puntos_movimientos pm WHERE pm.pedido_id = p.id::text
        )
        AND p.total > 0`
      for (const p of sinPuntos) {
        const puntos = Math.floor(Number(p.total) / 10)
        if (puntos < 1) continue
        await sql`UPDATE usuarios SET puntos = COALESCE(puntos,0) + ${puntos} WHERE id = ${p.cliente_id}`
        await sql`INSERT INTO puntos_movimientos (usuario_id, puntos, concepto, pedido_id)
          VALUES (${p.cliente_id}, ${puntos}, ${'Pedido entregado'}, ${p.id})`
      }
      if (sinPuntos.length > 0) console.log("Cron puntos: acreditados a " + sinPuntos.length + " pedidos")
    } catch (e: any) { logError(e, "cron:puntos") }
  })

  // Cada hora — recompensa al referidor cuando su referido hace su primer pedido
  cron.schedule("0 * * * *", async () => {
    try {
      const pendientes = await sql`
        SELECT r.referidor_id, r.referido_id
        FROM referidos r
        WHERE r.recompensa_aplicada = false
        AND EXISTS (
          SELECT 1 FROM pedidos p WHERE p.cliente_id = r.referido_id AND p.status = 'entregado' LIMIT 1
        )`
      for (const r of pendientes) {
        await sql`UPDATE usuarios SET wallet_balance = COALESCE(wallet_balance,0) + 30 WHERE id = ${r.referidor_id}`
        await sql`INSERT INTO wallet_movimientos (usuario_id, tipo, monto, concepto)
          VALUES (${r.referidor_id}, 'credito', 30, 'Recompensa por referido')`
        await sql`UPDATE referidos SET recompensa_aplicada = true WHERE referidor_id = ${r.referidor_id} AND referido_id = ${r.referido_id}`
        await sendPushToUser(sql, r.referidor_id, "¡Ganaste $30 de saldo!", "Tu referido hizo su primer pedido. ¡Ya tienes $30 de crédito!", { tipo: "referido_bonus" }).catch(() => {})
      }
      if (pendientes.length > 0) console.log("Cron referidos: " + pendientes.length + " recompensas aplicadas")
    } catch (e: any) { logError(e, "cron:referidos") }
  })

  console.log("Cron jobs iniciados")
}
