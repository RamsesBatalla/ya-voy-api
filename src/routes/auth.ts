import { Router } from "express";
import { sql } from "../db";
import { requireAuth, requireAuthUsuario } from "../middleware/auth";
import admin from "firebase-admin";
import { logError } from "../logger";

const router = Router();

router.post("/sync", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { email, nombre, fotoUrl, rol } = req.body;
    const rolSanitizado = ["cliente", "negocio", "repartidor"].includes(rol) ? rol : "cliente";
    await sql`
      INSERT INTO usuarios (id, email, nombre, foto_url, rol)
      VALUES (${userId}, ${email}, ${nombre}, ${fotoUrl}, ${rolSanitizado})
      ON CONFLICT (id) DO UPDATE SET
        email    = EXCLUDED.email,
        nombre   = CASE 
                     WHEN EXCLUDED.nombre IS NOT NULL AND TRIM(EXCLUDED.nombre) != '' THEN EXCLUDED.nombre 
                     ELSE usuarios.nombre 
                   END,
        foto_url = COALESCE(NULLIF(usuarios.foto_url, ''), EXCLUDED.foto_url),
        rol      = EXCLUDED.rol
    `;
    const rows = await sql`SELECT * FROM usuarios WHERE id = ${userId}`;
    res.json({ ok: true, usuario: rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/perfil/:userId", requireAuthUsuario, async (req, res) => {
  const uid = (req as any).usrUserId;
  if (uid !== req.params.userId) return res.status(403).json({ error: "Acceso denegado" });
  try {
    const rows = await sql`SELECT * FROM usuarios WHERE id = ${req.params.userId}`;
    if (!rows.length) return res.status(404).json({ error: "No encontrado" });
    res.json(rows[0]);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Busca otra cuenta en la BD con el mismo correo (distinto userId)
router.get("/verificar-duplicado", requireAuthUsuario, async (req, res) => {
  const userId = (req as any).usrUserId;
  const { email } = req.query;
  if (!email || !userId) return res.json({ duplicado: null });
  try {
    const rows = await sql`
      SELECT id, nombre, email
      FROM usuarios
      WHERE LOWER(email) = LOWER(${email as string}) AND id != ${userId}
      LIMIT 1
    `;
    res.json({ duplicado: rows[0] || null });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Fusiona la cuenta duplicada en la cuenta activa (transfiere datos y elimina el duplicado)
router.post("/fusionar", requireAuthUsuario, async (req, res) => {
  const userId = (req as any).usrUserId;
  const { duplicadoId } = req.body;
  if (!duplicadoId || !userId) return res.status(400).json({ error: "Faltan parámetros" });
  if (duplicadoId === userId) return res.status(400).json({ error: "No puedes fusionar la misma cuenta" });
  try {
    const [current] = await sql`SELECT email FROM usuarios WHERE id = ${userId}`;
    const [dup]     = await sql`SELECT email FROM usuarios WHERE id = ${duplicadoId}`;
    if (!current || !dup) return res.status(404).json({ error: "Usuario no encontrado" });
    if (current.email.toLowerCase() !== dup.email.toLowerCase())
      return res.status(403).json({ error: "Los correos no coinciden" });

    // Transferir datos al usuario actual
    await sql`UPDATE pedidos SET cliente_id   = ${userId} WHERE cliente_id   = ${duplicadoId}`;
    await sql`UPDATE pedidos SET repartidor_id = ${userId} WHERE repartidor_id = ${duplicadoId}`.catch(e => logError(e, "fusionar:pedidos_repartidor"));
    await sql`UPDATE solicitudes SET usuario_id = ${userId} WHERE usuario_id = ${duplicadoId}`.catch(e => logError(e, "fusionar:solicitudes"));
    await sql`UPDATE device_tokens SET user_id  = ${userId} WHERE user_id    = ${duplicadoId}`.catch(e => logError(e, "fusionar:device_tokens"));

    // Eliminar registro duplicado
    await sql`DELETE FROM reportes_soporte WHERE usuario_id = ${duplicadoId}`.catch(e => logError(e, "fusionar:reportes"));
    await sql`DELETE FROM usuarios WHERE id = ${duplicadoId}`;

    // Eliminar la cuenta Firebase del duplicado (best-effort)
    try { await admin.auth().deleteUser(duplicadoId); } catch {}

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
