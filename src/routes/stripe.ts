import { Router } from "express"
import Stripe from "stripe"
import { sql } from "../db"
import { requireAuth } from "../middleware/auth"
import { logError } from "../logger"
import { sendPushToUser } from "../firebase"
import { notificarCliente } from "../websocket"

const router = Router()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", { apiVersion: "2026-04-22.dahlia" })
const STRIPE_TEST_KEY = process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY || ""
const stripeTest = new Stripe(STRIPE_TEST_KEY, { apiVersion: "2026-04-22.dahlia" })

const getConfig = async () => {
  const rows = await sql`SELECT clave, valor FROM app_config WHERE clave IN ('comision_pct','fondo_pct','envio_precio_km','envio_minimo')`
  const cfg: Record<string,number> = {}
  rows.forEach((r: any) => { cfg[r.clave] = parseFloat(r.valor) })
  return {
    comisionPct: (cfg.comision_pct ?? 18) / 100,
    fondoPct:    (cfg.fondo_pct    ?? 20) / 100,
    precioPorKm: cfg.envio_precio_km ?? 8,
    envioMinimo: cfg.envio_minimo    ?? 25,
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

    const baseUrl = process.env.API_PUBLIC_URL || "https://batallagroup-tech.github.io/ya-voy"
    let accountId = existingAccountId
    let accountLinkUrl = ""

    // Función auxiliar para intentar con un cliente stripe dado
    const createOnboarding = async (client: any) => {
      let accId = accountId
      if (!accId) {
        const account = await client.accounts.create({
          type: "express",
          country: "MX",
          email: email || undefined,
          capabilities: { transfers: { requested: true } },
          business_profile: { name: nombre || tipo },
          metadata: { tipo, actorId },
        })
        accId = account.id
      }
      const link = await client.accountLinks.create({
        account: accId,
        refresh_url: baseUrl + "/stripe-connect-refresh",
        return_url:  baseUrl + "/stripe-connect-return",
        type: "account_onboarding",
      })
      return { accId, url: link.url }
    }

    try {
      // Intentar primero con el cliente configurado (Live)
      const resLive = await createOnboarding(stripe)
      accountId = resLive.accId
      accountLinkUrl = resLive.url
    } catch (liveErr: any) {
      console.warn("Stripe Connect Live no disponible (esperando verificación de identidad). Usando entorno de pruebas Connect:", liveErr.message)
      // Si falló por restricciones de live (ej. verificación de identidad requerida), usar stripeTest
      accountId = null; // forzar creación en test
      const resTest = await createOnboarding(stripeTest)
      accountId = resTest.accId
      accountLinkUrl = resTest.url
    }

    if (accountId) {
      if (tipo === "restaurante") {
        await sql`UPDATE viveres SET stripe_account_id = ${accountId} WHERE id = ${actorId}`
      } else {
        await sql`UPDATE repartidores SET stripe_account_id = ${accountId} WHERE id = ${actorId}`
      }
    }

    res.json({ url: accountLinkUrl, accountId })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ─── STATUS CONNECT ────────────────────────────────────────────────────────
// ─── VALIDAR CLABE BANXICO ──────────────────────────────────────────────────
export function validarClabeBanxico(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += (parseInt(clabe[i], 10) * weights[i]) % 10;
  }
  const control = (10 - (sum % 10)) % 10;
  return control === parseInt(clabe[17], 10);
}

// ─── STATUS CONNECT ────────────────────────────────────────────────────────
router.get("/connect/status/:tipo/:actorId", async (req, res) => {
  try {
    const { tipo, actorId } = req.params
    let accountId: string | null = null
    let clabe: string | null = null
    let banco: string | null = null
    let titular: string | null = null

    if (tipo === "restaurante") {
      const rows = await sql`
        SELECT stripe_account_id, clabe_bancaria, banco_nombre, titular_cuenta 
        FROM viveres 
        WHERE id = ${actorId} OR owner_id = ${actorId}
        LIMIT 1
      `
      accountId = rows[0]?.stripe_account_id || null
      clabe = rows[0]?.clabe_bancaria || null
      banco = rows[0]?.banco_nombre || null
      titular = rows[0]?.titular_cuenta || null
    } else if (tipo === "repartidor") {
      const rows = await sql`
        SELECT stripe_account_id, clabe_bancaria, banco_nombre, titular_cuenta 
        FROM repartidores 
        WHERE id = ${actorId} OR user_id = ${actorId}
        LIMIT 1
      `
      accountId = rows[0]?.stripe_account_id || null
      clabe = rows[0]?.clabe_bancaria || null
      banco = rows[0]?.banco_nombre || null
      titular = rows[0]?.titular_cuenta || null
    }

    if (!accountId) {
      return res.json({
        conectado: Boolean(clabe),
        accountId: null,
        tieneClabe: Boolean(clabe),
        clabe: clabe ? `•••• ${clabe.slice(-4)}` : null,
        clabeCompleta: clabe,
        banco,
        titular,
      })
    }

    let account: any = null
    try {
      account = await stripe.accounts.retrieve(accountId)
    } catch {
      try {
        account = await stripeTest.accounts.retrieve(accountId)
      } catch {}
    }

    const conectado = account ? !!(account.charges_enabled || account.payouts_enabled) : Boolean(clabe)
    res.json({
      conectado,
      accountId,
      chargesEnabled: account?.charges_enabled ?? false,
      payoutsEnabled: account?.payouts_enabled ?? false,
      tieneClabe: Boolean(clabe),
      clabe: clabe ? `•••• ${clabe.slice(-4)}` : null,
      clabeCompleta: clabe,
      banco,
      titular,
    })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ─── GUARDAR CLABE BANCARIA DIRECTA ─────────────────────────────────────────
router.post("/connect/clabe", requireAuth, async (req, res) => {
  try {
    const { tipo, actorId, clabe, banco, titular } = req.body
    if (!tipo || !actorId || !clabe) return res.status(400).json({ error: "tipo, actorId y clabe requeridos" })
    
    const clabeClean = String(clabe).trim().replace(/\D/g, "")
    if (clabeClean.length !== 18) {
      return res.status(400).json({ error: "La CLABE interbancaria debe tener exactamente 18 dígitos numéricos" })
    }

    if (!validarClabeBanxico(clabeClean)) {
      return res.status(400).json({ error: "El dígito de control de la CLABE es inválido. Verifica los 18 dígitos según tu banco." })
    }

    if (tipo === "restaurante") {
      await sql`
        UPDATE viveres SET
          clabe_bancaria = ${clabeClean},
          banco_nombre = ${banco || ""},
          titular_cuenta = ${titular || ""}
        WHERE id = ${actorId} OR owner_id = ${actorId}
      `
    } else {
      await sql`
        UPDATE repartidores SET
          clabe_bancaria = ${clabeClean},
          banco_nombre = ${banco || ""},
          titular_cuenta = ${titular || ""}
        WHERE id = ${actorId} OR user_id = ${actorId}
      `
    }
    res.json({ 
      ok: true, 
      conectado: true,
      clabe: `•••• ${clabeClean.slice(-4)}`,
      banco: banco || "",
      titular: titular || ""
    })
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
      await sql`INSERT INTO usuarios (id, stripe_customer_id) VALUES (${userId}, ${customerId}) ON CONFLICT (id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`
    }
    res.json({ customerId })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post("/setup-intent", requireAuth, async (req, res) => {
  try {
    const { userId, email, nombre } = req.body
    if (!userId) return res.status(400).json({ error: "userId requerido" })
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`
    const rows = await sql`SELECT id, email, nombre, stripe_customer_id FROM usuarios WHERE id = ${userId}`
    let customerId = rows[0]?.stripe_customer_id
    if (!customerId) {
      const userEmail = email || rows[0]?.email || undefined
      const userName = nombre || rows[0]?.nombre || undefined
      const customer = await stripe.customers.create({ email: userEmail, name: userName, metadata: { userId } })
      customerId = customer.id
      await sql`
        INSERT INTO usuarios (id, email, nombre, stripe_customer_id)
        VALUES (${userId}, ${userEmail || ''}, ${userName || ''}, ${customerId})
        ON CONFLICT (id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id
      `
    }
    const setupIntent = await stripe.setupIntents.create({ customer: customerId, payment_method_types: ["card"] })
    res.json({ clientSecret: setupIntent.client_secret, customerId })
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

