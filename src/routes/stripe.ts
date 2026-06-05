import { Router } from "express"
import Stripe from "stripe"
import { sql } from "../db"
import { requireAuth } from "../middleware/auth"
import { logError } from "../logger"
import { sendPushToUser } from "../firebase"
import { notificarCliente } from "../websocket"

const router = Router()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", { apiVersion: "2026-04-22.dahlia" })

const getConfig = async () => {
  const rows = await sql`SELECT clave, valor FROM app_config WHERE clave IN ('comision_pct','fondo_pct','envio_precio_km','envio_minimo')`
  const cfg: Record<string,number> = {}
  rows.forEach((r: any) => { cfg[r.clave] = parseFloat(r.valor) })
  return {
    comisionPct: (cfg.comision_pct ?? 18) / 100,
    fondoPct:    (cfg.fondo_pct    ?? 20) / 100,
    precioPorKm: cfg.envio_precio_km ?? 12,
    envioMinimo: cfg.envio_minimo    ?? 35,
  }
}

// ─── CALCULAR COSTO ENVIO ─────────────────────────────────────────────────
router.post("/calcular-envio", async (req, res) => {
  try {
    const { latUsuario, lngUsuario, latNegocio, lngNegocio } = req.body
    if (!latUsuario || !lngUsuario || !latNegocio || !lngNegocio)
      return res.status(400).json({ error: "Coordenadas requeridas" })

    const url = "http://router.project-osrm.org/route/v1/driving/" +
      lngNegocio + "," + latNegocio + ";" + lngUsuario + "," + latUsuario +
      "?overview=false"

    const r = await fetch(url)
    const data: any = await r.json()
    const distanciaKm = (data.routes?.[0]?.distance ?? 0) / 1000

    const cfg = await getConfig()
    const costoEnvio = Math.max(cfg.envioMinimo, Math.round(distanciaKm * cfg.precioPorKm))

    const tiempoMin = Math.ceil(distanciaKm / 25 * 60) + 10 // velocidad promedio 25km/h + 10min prep
    const tiempoEstimado = tiempoMin <= 15 ? "10-15 min" : tiempoMin <= 25 ? "15-25 min" : tiempoMin <= 40 ? "25-40 min" : Math.ceil(tiempoMin/5)*5 + " min"
    res.json({ distanciaKm: Math.round(distanciaKm * 10) / 10, costoEnvio, tiempoEstimado, tiempoMinutos: tiempoMin })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ─── PAYMENT INTENT ────────────────────────────────────────────────────────
router.post("/payment-intent", requireAuth, async (req, res) => {
  try {
    const { userId: authUserId } = (req as any).auth ?? {}
    const { amount, currency = "mxn", negocioId, repartidorId, costoEnvio, metadata = {} } = req.body
    if (!amount || amount < 10) return res.status(400).json({ error: "Monto invalido" })

    const cfg = await getConfig()
    const amountCentavos = Math.round(amount * 100)
    const subtotalSinEnvio = Math.round((amount - (costoEnvio || 0)) * 100)
    const comisionCentavos = Math.round(subtotalSinEnvio * cfg.comisionPct)

    let transferData: any = undefined
    let applicationFee: number | undefined = undefined

    if (negocioId) {
      const negocios = await sql`SELECT stripe_account_id FROM viveres WHERE id = ${negocioId}`
      const negocio = negocios[0]
      if (negocio?.stripe_account_id) {
        applicationFee = comisionCentavos
        transferData = { destination: negocio.stripe_account_id }
      }
    }

    const piParams: any = {
      amount: amountCentavos,
      currency,
      metadata: {
        negocioId: negocioId || "",
        repartidorId: repartidorId || "",
        costoEnvio: String(costoEnvio || 0),
        userId: authUserId || "",
        ...metadata
      },
      automatic_payment_methods: { enabled: true },
    }

    if (transferData) {
      piParams.application_fee_amount = applicationFee
      piParams.transfer_data = transferData
    }

    const paymentIntent = await stripe.paymentIntents.create(piParams)
    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ─── VERIFICAR ESTADO PAGO ─────────────────────────────────────────────────
router.get("/payment-intent/:id", async (req, res) => {
  try {
    const pi = await stripe.paymentIntents.retrieve(req.params.id)
    res.json({ status: pi.status, amount: pi.amount / 100 })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ─── ONBOARDING CONNECT ────────────────────────────────────────────────────
router.post("/connect/onboarding", requireAuth, async (req, res) => {
  try {
    const { tipo, actorId, email, nombre } = req.body
    if (!tipo || !actorId) return res.status(400).json({ error: "tipo y actorId requeridos" })

    let existingAccountId: string | null = null
    if (tipo === "restaurante") {
      const rows = await sql`SELECT stripe_account_id FROM viveres WHERE id = ${actorId}`
      existingAccountId = rows[0]?.stripe_account_id || null
    } else if (tipo === "repartidor") {
      const rows = await sql`SELECT stripe_account_id FROM repartidores WHERE id = ${actorId}`
      existingAccountId = rows[0]?.stripe_account_id || null
    }

    let accountId = existingAccountId
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "MX",
        email: email || undefined,
        capabilities: { transfers: { requested: true } },
        business_profile: { name: nombre || tipo },
        metadata: { tipo, actorId },
      })
      accountId = account.id

      if (tipo === "restaurante") {
        await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS stripe_account_id TEXT`
        await sql`UPDATE viveres SET stripe_account_id = ${accountId} WHERE id = ${actorId}`
      } else {
        await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS stripe_account_id TEXT`
        await sql`UPDATE repartidores SET stripe_account_id = ${accountId} WHERE id = ${actorId}`
      }
    }

    // return_url y refresh_url deben ser URLs HTTPS alcanzables por Stripe.
    // En apps nativas (Capacitor), browserFinished detecta el cierre y re-verifica el status.
    // Usamos la URL de la API propia como fallback universal.
    const baseUrl = process.env.API_PUBLIC_URL || "https://batallagroup-tech.github.io/ya-voy"
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: baseUrl + "/stripe-connect-refresh",
      return_url:  baseUrl + "/stripe-connect-return",
      type: "account_onboarding",
    })

    res.json({ url: accountLink.url, accountId })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ─── STATUS CONNECT ────────────────────────────────────────────────────────
router.get("/connect/status/:tipo/:actorId", async (req, res) => {
  try {
    const { tipo, actorId } = req.params
    let accountId: string | null = null

    if (tipo === "restaurante") {
      const rows = await sql`SELECT stripe_account_id FROM viveres WHERE id = ${actorId}`
      accountId = rows[0]?.stripe_account_id || null
    } else if (tipo === "repartidor") {
      const rows = await sql`SELECT stripe_account_id FROM repartidores WHERE id = ${actorId}`
      accountId = rows[0]?.stripe_account_id || null
    }

    if (!accountId) return res.json({ conectado: false, accountId: null })

    const account = await stripe.accounts.retrieve(accountId)
    const conectado = !!(account.charges_enabled && account.payouts_enabled)
    res.json({ conectado, accountId, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ─── WEBHOOK ───────────────────────────────────────────────────────────────
router.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"] as string
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || ""

  let event: any
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
  } catch (e: any) {
    return res.status(400).json({ error: "Webhook signature invalid" })
  }

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object as any
    const repartidorId = pi.metadata?.repartidorId
    const pedidoId     = pi.metadata?.pedidoId

    // Activar pedido si estaba pendiente_pago y notificar al restaurante
    if (pedidoId) {
      try {
        const rows = await sql`
          UPDATE pedidos SET status = 'nuevo', actualizado_en = NOW()
          WHERE id = ${pedidoId} AND status = 'pendiente_pago'
          RETURNING negocio_id, cliente_id, costo_envio, propina`
        if (rows[0]?.negocio_id) {
          const negocio = await sql`SELECT owner_id, nombre FROM viveres WHERE id = ${rows[0].negocio_id}`
          if (negocio[0]?.owner_id) {
            notificarCliente(negocio[0].owner_id, "nuevo_pedido", { id: pedidoId })
            await sendPushToUser(sql, negocio[0].owner_id, "Nuevo pedido", `Pago confirmado — tienes un pedido en ${negocio[0]?.nombre}`, { pedidoId }).catch(() => {})
          }
        }

        // Si hay repartidor ya asignado, transferirle costo_envio + propina reales del pedido
        const repId = repartidorId || rows[0]?.repartidor_id
        if (repId && rows[0]) {
          const montoTotal = Number(rows[0].costo_envio || 35) + Number(rows[0].propina || 0)
          const repRows = await sql`SELECT stripe_account_id FROM repartidores WHERE id = ${repId}`
          const repAccountId = repRows[0]?.stripe_account_id
          if (repAccountId) {
            await stripe.transfers.create({
              amount: Math.round(montoTotal * 100),
              currency: "mxn",
              destination: repAccountId,
              source_transaction: pi.latest_charge as string,
              metadata: { paymentIntentId: pi.id, pedidoId, repId },
            }).catch(e => logError(e, "stripe:transfer"))
          }
        }
      } catch (e: any) { logError(e, "stripe:activar_pedido") }

    } else if (repartidorId) {
      // Flujo legacy sin pedidoId: transferir solo costo envío del metadata
      const costoEnvio = Math.max(35, parseFloat(pi.metadata?.costoEnvio || "35") || 35)
      try {
        const rows = await sql`SELECT stripe_account_id FROM repartidores WHERE id = ${repartidorId}`
        const repAccountId = rows[0]?.stripe_account_id
        if (repAccountId) {
          await stripe.transfers.create({
            amount: Math.round(costoEnvio * 100),
            currency: "mxn",
            destination: repAccountId,
            source_transaction: pi.latest_charge as string,
            metadata: { paymentIntentId: pi.id, repartidorId },
          })
        }
      } catch (e: any) { logError(e, "stripe:transfer_legacy") }
    }
  }

  else if (event.type === "payment_intent.payment_failed") {
    const pi = event.data.object as any
    const userId  = pi.metadata?.userId
    const pedidoId = pi.metadata?.pedidoId
    try {
      if (pedidoId) {
        await sql`UPDATE pedidos SET status = 'pago_fallido', pago_fallido_en = NOW() WHERE id = ${pedidoId} AND status = 'nuevo'`
      }
      if (userId) {
        await sendPushToUser(sql, userId,
          "Pago no procesado",
          "No pudimos cobrar tu pedido. Toca aquí para reintentar.",
          { tipo: "pago_fallido", pedidoId: pedidoId || "" }
        ).catch(() => {})
      }
    } catch (e: any) { logError(e, "stripe:payment_failed") }
  }

  else if (event.type === "charge.dispute.created") {
    const dispute = event.data.object as any
    logError(
      new Error(`Contracargo recibido: ${dispute.id} — monto $${(dispute.amount / 100).toFixed(2)} MXN — razón: ${dispute.reason}`),
      "stripe:dispute"
    )
  }

  else if (event.type === "charge.refunded") {
    const charge = event.data.object as any
    const userId = charge.metadata?.userId
    if (userId) {
      await sendPushToUser(sql, userId,
        "Reembolso procesado",
        `Tu reembolso de $${(charge.amount_refunded / 100).toFixed(2)} MXN ha sido procesado.`,
        { tipo: "reembolso" }
      ).catch(() => {})
    }
  }

  res.json({ received: true })
})

// ─── CUSTOMER + TARJETAS GUARDADAS ────────────────────────────────────────

router.post("/customer", requireAuth, async (req, res) => {
  try {
    const { userId, email, nombre } = req.body
    if (!userId) return res.status(400).json({ error: "userId requerido" })
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`
    const rows = await sql`SELECT stripe_customer_id FROM usuarios WHERE id = ${userId}`
    let customerId = rows[0]?.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({ email: email || undefined, name: nombre || undefined, metadata: { userId } })
      customerId = customer.id
      await sql`UPDATE usuarios SET stripe_customer_id = ${customerId} WHERE id = ${userId}`
    }
    res.json({ customerId })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post("/setup-intent", requireAuth, async (req, res) => {
  try {
    const { userId } = req.body
    if (!userId) return res.status(400).json({ error: "userId requerido" })
    const rows = await sql`SELECT stripe_customer_id FROM usuarios WHERE id = ${userId}`
    const customerId = rows[0]?.stripe_customer_id
    if (!customerId) return res.status(400).json({ error: "Customer no encontrado" })
    const setupIntent = await stripe.setupIntents.create({ customer: customerId, payment_method_types: ["card"] })
    res.json({ clientSecret: setupIntent.client_secret })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.get("/payment-methods/:userId", requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT stripe_customer_id FROM usuarios WHERE id = ${req.params.userId}`
    const customerId = rows[0]?.stripe_customer_id
    if (!customerId) return res.json({ cards: [] })
    const methods = await stripe.paymentMethods.list({ customer: customerId, type: "card" })
    const cards = methods.data.map(pm => ({
      id: pm.id, brand: pm.card?.brand, last4: pm.card?.last4,
      exp_month: pm.card?.exp_month, exp_year: pm.card?.exp_year,
    }))
    res.json({ cards })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.delete("/payment-methods/:pmId", requireAuth, async (req, res) => {
  try {
    await stripe.paymentMethods.detach(req.params.pmId)
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
