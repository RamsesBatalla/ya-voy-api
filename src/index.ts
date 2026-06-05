import "./instrument"; // Sentry debe inicializarse antes que cualquier otro import
import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { clerkMiddleware } from "@clerk/express";
import authRouter          from "./routes/auth";
import negociosRouter      from "./routes/negocios";
import productosRouter     from "./routes/productos";
import pedidosRouter       from "./routes/pedidos";
import negocioRouter       from "./routes/negocio";
import usuarioRouter       from "./routes/usuario";
import repartidorRouter    from "./routes/repartidor";
import configRouter        from "./routes/config";
import notificationsRouter from "./routes/notifications";
import stripeRouter        from "./routes/stripe";
import soporteRouter       from "./routes/soporte";
import bloqueosRouter      from "./routes/bloqueos";
import retirosRouter       from "./routes/retiros";
import fondoRouter         from "./routes/fondo";
import contingenciasRouter from "./routes/contingencias";
import mensajesRouter      from "./routes/mensajes";
import adminRouter         from "./routes/admin";
import engagementRouter    from "./routes/engagement";
import { initCronJobs } from "./cron";
import { runMigrations } from "./migrations";
import { createServer } from "http"
import { initWebSocket } from "./websocket"

const app = express();
const PORT = process.env.PORT || 3001;

const isDev = process.env.NODE_ENV !== "production";

const origins = [
  process.env.FRONTEND_RESTAURANTE || "http://localhost:5173",
  process.env.FRONTEND_USUARIO     || "http://localhost:5174",
  process.env.FRONTEND_REPARTIDOR  || "http://localhost:5175",
];

// ── Seguridad: headers ────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // permite imágenes de Cloudinary
  contentSecurityPolicy: false,                          // desactivado — manejado por el frontend
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
const corsOrigin = isDev
  ? (_origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => cb(null, true)
  : origins;
app.use(cors({ origin: corsOrigin, credentials: true }));

// ── Rate limiting (solo en producción) ───────────────────────────────────────

if (!isDev) {
  // Global: 300 req / 15 min por IP
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Demasiadas solicitudes, intenta en unos minutos" },
  }));

  // Endpoints sensibles: 30 req / 15 min
  const limitEstricto = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Demasiadas solicitudes, intenta en unos minutos" },
  });

  app.use("/api/stripe/payment-intent", limitEstricto);
  app.use("/api/stripe/setup-intent",   limitEstricto);
  app.use("/api/retiros",               limitEstricto);
  app.use("/api/soporte",               limitEstricto);
}

// ── Webhook Stripe (body crudo, antes del JSON parser) ────────────────────────
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res, next) => {
  (stripeRouter as any).handle(req, res, next);
});

app.use(express.json({ limit: "10mb" }));

// ── Clerk (antes de todas las rutas) ─────────────────────────────────────────
app.use(clerkMiddleware());

// ── Rutas públicas ────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/api/mantenimiento", async (_req, res) => {
  try {
    const { sql } = await import("./db");
    const r = await sql`SELECT valor FROM app_config WHERE clave = 'mantenimiento'`;
    res.json({ mantenimiento: r[0]?.valor === "true" });
  } catch { res.json({ mantenimiento: false }); }
});

// ── Rutas (auth aplicada internamente por endpoint) ───────────────────────────
app.use("/api/stripe",             stripeRouter);
app.use("/api/bloqueos",           bloqueosRouter);
app.use("/api/retiros",            retirosRouter);
app.use("/api/fondo",              fondoRouter);
app.use("/api/contingencias",      contingenciasRouter);
app.use("/api/mensajes",           mensajesRouter);
app.use("/api/repartidor/online",  repartidorRouter);
app.use("/api/repartidor/pedidos", repartidorRouter);

app.use("/api/auth",          authRouter);
app.use("/api/negocios",      negociosRouter);
app.use("/api/negocios",      productosRouter);
app.use("/api/negocios",      pedidosRouter);
app.use("/api/negocios",      negocioRouter);
app.use("/api/usuario",       usuarioRouter);
app.use("/api/repartidor",    repartidorRouter);
app.use("/api/config",        configRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/soporte",       soporteRouter);
app.use("/api/admin",         adminRouter);
app.use("/api/usuario",       engagementRouter);

// ── Sentry error handler (debe ir después de las rutas) ───────────────────
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

// ── Advertencias de configuración ────────────────────────────────────────────
if (!process.env.STRIPE_WEBHOOK_SECRET)
  console.warn("⚠️  STRIPE_WEBHOOK_SECRET no configurado — los webhooks de Stripe no funcionarán")
if (!process.env.SENTRY_DSN)
  console.warn("⚠️  SENTRY_DSN no configurado — los errores no se reportarán a Sentry")

const server = createServer(app);
initWebSocket(server);
server.listen(PORT, async () => {
  console.log(`YA VOY API en http://localhost:${PORT}`);
  await runMigrations().catch(e => console.error("Error migraciones:", e.message));
  initCronJobs();
});
export default app;
