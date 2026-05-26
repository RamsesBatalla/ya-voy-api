import "dotenv/config";
import express from "express";
import cors from "cors";
import { clerkMiddleware } from "@clerk/express";
import authRouter      from "./routes/auth";
import negociosRouter  from "./routes/negocios";
import productosRouter from "./routes/productos";
import pedidosRouter   from "./routes/pedidos";
import negocioRouter   from "./routes/negocio";
import usuarioRouter   from "./routes/usuario";
import repartidorRouter from "./routes/repartidor";
import configRouter    from "./routes/config";
import notificationsRouter from "./routes/notifications";

const app = express();
const PORT = process.env.PORT || 3001;

const origins = [
  process.env.FRONTEND_RESTAURANTE || "http://localhost:5173",
  process.env.FRONTEND_USUARIO     || "http://localhost:5174",
  process.env.FRONTEND_REPARTIDOR  || "http://localhost:5175",
];

app.use(cors({ origin: origins, credentials: true }));
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use(clerkMiddleware());
app.use("/api/auth",        authRouter);
app.use("/api/negocios",    negociosRouter);
app.use("/api/negocios",    productosRouter);
app.use("/api/negocios",    pedidosRouter);
app.use("/api/negocios",    negocioRouter);
app.use("/api/usuario",     usuarioRouter);
app.use("/api/repartidor",  repartidorRouter);
app.use("/api/config",      configRouter);
app.use("/api/notifications", notificationsRouter);

app.listen(PORT, () => console.log(`YA VOY API en http://localhost:${PORT}`));
export default app;
