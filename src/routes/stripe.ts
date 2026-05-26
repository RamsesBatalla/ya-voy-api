import { Router } from "express"
import Stripe from "stripe"
import { getAuth } from "@clerk/express"

const router = Router()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", { apiVersion: "2024-06-20" })

// Crear PaymentIntent
router.post("/payment-intent", async (req, res) => {
  try {
    const { userId } = getAuth(req)
    if (!userId) return res.status(401).json({ error: "No autenticado" })

    const { amount, currency = "mxn", metadata = {} } = req.body
    if (!amount || amount < 10) return res.status(400).json({ error: "Monto invalido" })

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // centavos
      currency,
      metadata: { userId, ...metadata },
      automatic_payment_methods: { enabled: true },
    })

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Verificar estado del pago
router.get("/payment-intent/:id", async (req, res) => {
  try {
    const pi = await stripe.paymentIntents.retrieve(req.params.id)
    res.json({ status: pi.status, amount: pi.amount / 100 })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router