import { Router } from "express";
import { sql } from "../db";

const router = Router();

router.patch("/:id/toggle", async (req, res) => {
  try {
    const rows = await sql`
      UPDATE viveres SET esta_abierto = NOT esta_abierto
      WHERE id = ${req.params.id} RETURNING *
    `;
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
