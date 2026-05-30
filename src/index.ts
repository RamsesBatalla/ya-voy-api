import "dotenv/config";
import express from "express";
import cors from "cors";
import { clerkMiddleware } from "@clerk/express";
import authRouter         from "./routes/auth";
import negociosRouter     from "./routes/negocios";
import productosRouter    from "./routes/productos";
import pedidosRouter      from "./routes/pedidos";
import negocioRouter      from "./routes/negocio";
import usuarioRouter      from "./routes/usuario";
import repartidorRouter   from "./routes/repartidor";
import configRouter       from "./routes/config";
import notificationsRouter from "./routes/notifications";
import stripeRouter       from "./routes/stripe";
import soporteRouter      from "./routes/soporte";
import bloqueosRouter     from "./routes/bloqueos";
import retirosRouter      from "./routes/retiros";
import fondoRouter        from "./routes/fondo";
import { initCronJobs } from "./cron";

const app = express();
const PORT = process.env.PORT || 3001;

const origins = [
  process.env.FRONTEND_RESTAURANTE || "http://localhost:5173",
  process.env.FRONTEND_USUARIO     || "http://localhost:5174",
  process.env.FRONTEND_REPARTIDOR  || "http://localhost:5175",
];

app.use(cors({ origin: origins, credentials: true }));

// Webhook Stripe necesita body RAW — va ANTES de express.json()
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res, next) => {
  (stripeRouter as any).handle(req, res, next);
});

app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.use("/api/stripe",   stripeRouter);
app.use("/api/bloqueos", bloqueosRouter);
app.use("/api/retiros",  retirosRouter);
app.use("/api/fondo",    fondoRouter);

app.use(clerkMiddleware());
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

app.listen(PORT, () => { console.log(`YA VOY API en http://localhost:${PORT}`); initCronJobs(); });
export default app;
