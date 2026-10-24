import "./instrument"; // Sentry debe inicializarse antes que cualquier otro import
import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
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
import telegramRouter, { startTelegramPolling } from "./routes/telegram";
import { initCronJobs } from "./cron";
import { runMigrations } from "./migrations";
import { createServer } from "http"
import { initWebSocket } from "./websocket"

const app = express();
app.set("trust proxy", 1);
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
const corsOrigin = (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
  // Peticiones sin origin (apps nativas, curl, etc.)
  if (!origin) return cb(null, true);
  // Peticiones locales o de Capacitor
  if (
    origin.startsWith("http://localhost") ||
    origin.startsWith("https://localhost") ||
    origin.startsWith("capacitor://") ||
    origin.includes("onrender.com") ||
    origin.includes("github.io") ||
    origins.includes(origin)
  ) {
    return cb(null, true);
  }
  return cb(null, true);
};
app.use(cors({ origin: corsOrigin, credentials: true }));

// ── Rate limiting (solo en producción) ───────────────────────────────────────

if (!isDev) {
  // Global: 1500 req / 15 min por IP real del cliente
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1500,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === "/api/health" || req.path === "/api/mantenimiento" || req.path === "/api/app-versions",
    message: { error: "Demasiadas solicitudes, intenta en unos minutos" },
  }));

  // Endpoints sensibles: 100 req / 15 min
  const limitEstricto = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
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

// ── Rutas públicas ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
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
app.use("/api/app-versions", (req, res, next) => { req.url = "/versions"; (configRouter as any)(req, res, next); });
app.use("/api/notificaciones", notificationsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/soporte",       soporteRouter);
app.use("/api/admin",         adminRouter);
app.use("/api/usuario",       engagementRouter);
app.use("/api/telegram",      telegramRouter);

// ── Sentry error handler (debe ir después de las rutas) ───────────────────
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

// ── Advertencias de configuración ────────────────────────────────────────────
if (!process.env.STRIPE_WEBHOOK_SECRET)
  console.warn("⚠️  STRIPE_WEBHOOK_SECRET no configurado — los webhooks de Stripe no funcionarán")
if (!process.env.SENTRY_DSN)
  console.warn("⚠️  SENTRY_DSN no configurado — los errores no se reportarán a Sentry")

function initKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || "https://ya-voy-api.onrender.com";
  // Ping periódico cada 8 minutos para evitar que Render suspenda la instancia por inactividad
  setInterval(() => {
    fetch(`${url}/api/health`)
      .then((r) => r.json())
      .then((d: any) => console.log(`[keep-alive] Heartbeat exitoso a ${url}/api/health:`, d?.ts))
      .catch((err: any) => console.warn(`[keep-alive] Error en heartbeat:`, err.message));
  }, 8 * 60 * 1000);
}

const server = createServer(app);
initWebSocket(server);
server.listen(PORT, async () => {
  console.log(`YA VOY API en http://localhost:${PORT}`);
  await runMigrations().catch(e => console.error("Error migraciones:", e.message));
  initCronJobs();
  initKeepAlive();
  startTelegramPolling();
});
export default app;
