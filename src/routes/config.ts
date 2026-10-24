import { Router, Request, Response } from "express";
import { sql } from "../db";
import { requireAdmin } from "../middleware/auth";

const router = Router();

// GET /api/config — publico, lo leen las apps
router.get("/", async (_req: Request, res: Response) => {
  try {
    const rows = await sql`SELECT clave, valor FROM app_config`;
    const config: Record<string, string> = {};
    rows.forEach((r: any) => { config[r.clave] = r.valor; });
    res.json(config);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/config/versions — verificación de actualizaciones en las 3 apps
router.get("/versions", async (_req: Request, res: Response) => {
  try {
    const rows = await sql`SELECT clave, valor FROM app_config WHERE clave LIKE 'version_%'`;
    const cfg: Record<string, string> = {};
    rows.forEach((r: any) => { cfg[r.clave] = r.valor; });

    const versions = {
      usuario: {
        latestVersionCode: Number(cfg.version_usuario_code || 46),
        latestVersionName: cfg.version_usuario_name || "1.3.5",
        minVersionCode: Number(cfg.version_usuario_min || 46),
        forceUpdate: cfg.version_usuario_force === "true",
        title: "¡Nueva versión disponible en Google Play!",
        message: "Actualiza Ya Voy para disfrutar de recompensas diarias mejoradas, monedero rápido y notificaciones en tiempo real.",
        storeUrl: "https://play.google.com/store/apps/details?id=com.batallagroup.yavoy.usuario"
      },
      repartidor: {
        latestVersionCode: Number(cfg.version_repartidor_code || 37),
        latestVersionName: cfg.version_repartidor_name || "1.2.6",
        minVersionCode: Number(cfg.version_repartidor_min || 37),
        forceUpdate: cfg.version_repartidor_force === "true",
        title: "¡Nueva versión de Ya Voy Repartidor!",
        message: "Actualiza para contar con desconexión automática garantizada y alertas prioritarias de pedidos en tu zona.",
        storeUrl: "https://play.google.com/store/apps/details?id=com.batallagroup.yavoy.repartidor"
      },
      restaurante: {
        latestVersionCode: Number(cfg.version_restaurante_code || 43),
        latestVersionName: cfg.version_restaurante_name || "1.3.1",
        minVersionCode: Number(cfg.version_restaurante_min || 43),
        forceUpdate: cfg.version_restaurante_force === "true",
        title: "¡Nueva versión de Ya Voy Restaurante!",
        message: "Actualiza tu aplicación comercial para recibir nuevos pedidos al instante y optimizar tus horarios y menú.",
        storeUrl: "https://play.google.com/store/apps/details?id=com.batallagroup.yavoy.restaurante"
      }
    };
    res.json(versions);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/config/:clave — solo admin
router.put("/:clave", requireAdmin, async (req: Request, res: Response) => {
  const { clave } = req.params;
  const { valor } = req.body;
  try {
    await sql`UPDATE app_config SET valor = ${valor} WHERE clave = ${clave}`;
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
