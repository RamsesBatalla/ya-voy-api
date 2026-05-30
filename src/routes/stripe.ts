import { Router } from "express"
import Stripe from "stripe"
import { sql } from "../db"

const router = Router()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", { apiVersion: "2026-04-22.dahlia" })

const COMISION_PCT = 0.12  // 12% Batalla Group
const ENVIO = 35           // costo fijo de envio en MXN

// ─── PAYMENT INTENT ────────────────────────────────────────────────────────
router.post("/payment-intent", async (req, res) => {
  try {
    const { amount, currency = "mxn", negocioId, repartidorId, metadata = {} } = req.body
    if (!amount || amount < 10) return res.status(400).json({ error: "Monto invalido" })

    const amountCentavos = Math.round(amount * 100)
    const comisionCentavos = Math.round(amountCentavos * COMISION_PCT)

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

    const piParams: Stripe.PaymentIntentCreateParams = {
      amount: amountCentavos,
      currency,
      metadata: { negocioId: negocioId || "", repartidorId: repartidorId || "", ...metadata },
      automatic_payment_methods: { enabled: true },
    }

    if (transferData) {
      piParams.application_fee_amount = applicationFee
      piParams.transfer_data = transferData
    }

    const paymentIntent = await stripe.paymentIntents.create(piParams)

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    })
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
router.post("/connect/onboarding", async (req, res) => {
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

    const origin = process.env.FRONTEND_RESTAURANTE || "http://localhost:5173"
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/stripe-connect-refresh`,
      return_url: `${origin}/stripe-connect-return`,
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

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
  } catch (e: any) {
    return res.status(400).json({ error: "Webhook signature invalid" })
  }

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object as Stripe.PaymentIntent
    const repartidorId = pi.metadata?.repartidorId

    if (repartidorId) {
      try {
        const rows = await sql`SELECT stripe_account_id FROM repartidores WHERE id = ${repartidorId}`
        const repAccountId = rows[0]?.stripe_account_id
        if (repAccountId) {
          await stripe.transfers.create({
            amount: Math.round(ENVIO * 100),
            currency: "mxn",
            destination: repAccountId,
            source_transaction: pi.latest_charge as string,
            metadata: { paymentIntentId: pi.id, repartidorId },
          })
        }
      } catch (e: any) {
        console.error("Error transfiriendo a repartidor:", e.message)
      }
    }
  }

  res.json({ received: true })
})

export default router
