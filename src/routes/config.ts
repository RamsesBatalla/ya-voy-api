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
