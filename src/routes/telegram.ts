import { Router } from "express";
import { aprobarRestaurante, rechazarRestaurante } from "../services/solicitudesService";
import { logError } from "../logger";

const router = Router();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8756989292:AAHqQXQTqZBPZuEtY3RSbERf3HMwU5-HVWk";
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "1269146838";

/**
 * Responde a Telegram para quitar el spinner del botón
 */
async function answerCallbackQuery(callbackQueryId: string, text: string, showAlert = false) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: showAlert,
      }),
    });
  } catch (err: any) {
    logError(err, "answerCallbackQuery");
  }
}

/**
 * Modifica el mensaje en Telegram para mostrar el nuevo estado
 */
async function editTelegramMessage(chatId: string | number, messageId: number, newText: string, buttons?: any) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: newText,
        parse_mode: "Markdown",
        reply_markup: buttons ? { inline_keyboard: buttons } : { inline_keyboard: [] },
      }),
    });
  } catch (err: any) {
    logError(err, "editTelegramMessage");
  }
}

/**
 * Webhook de Telegram para recibir interacciones de botones
 */
router.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responder 200 OK inmediatamente a Telegram

  const update = req.body;
  if (!update || !update.callback_query) return;

  const cq = update.callback_query;
  const fromId = String(cq.from?.id);
  const data = cq.data || "";
  const message = cq.message;
  const messageId = message?.message_id;
  const originalText = message?.text || "";

  // Seguridad: Solo el Administrador autorizado puede presionar botones
  if (fromId !== ADMIN_CHAT_ID) {
    await answerCallbackQuery(cq.id, "⛔ No estás autorizado para realizar esta acción.", true);
    return;
  }

  // 1. APROBAR RESTAURANTE
  if (data.startsWith("aprob_res:")) {
    const solicitudId = data.replace("aprob_res:", "");
    const result = await aprobarRestaurante(solicitudId);

    if (result.ok) {
      await answerCallbackQuery(cq.id, `✅ ¡"${result.nombre}" ha sido aprobado con éxito! 🎉`);

      const horaActual = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
      const updatedText = `${originalText}\n\n` +
        `══════════════════════════\n` +
        `✅ *ESTADO: APROBADO*\n` +
        `👤 *Aprobado por:* @${cq.from.username || "Ramses"}\n` +
        `📅 *Fecha:* ${horaActual}\n` +
        `🔒 *Privacidad:* Documentos (INE y Selfie) *eliminados permanentemente* de Supabase Storage.`;

      await editTelegramMessage(ADMIN_CHAT_ID, messageId, updatedText);
    } else {
      await answerCallbackQuery(cq.id, `⚠️ Error al aprobar: ${result.error || "Solicitud ya procesada"}`, true);
    }
    return;
  }

  // 2. RECHAZAR RESTAURANTE
  if (data.startsWith("rech_res:")) {
    const solicitudId = data.replace("rech_res:", "");
    const result = await rechazarRestaurante(solicitudId);

    if (result.ok) {
      await answerCallbackQuery(cq.id, `❌ Solicitud rechazada. Documentos eliminados.`);

      const horaActual = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
      const updatedText = `${originalText}\n\n` +
        `══════════════════════════\n` +
        `❌ *ESTADO: RECHAZADO*\n` +
        `👤 *Rechazado por:* @${cq.from.username || "Ramses"}\n` +
        `📅 *Fecha:* ${horaActual}\n` +
        `🔒 *Privacidad:* Documentos (INE y Selfie) *eliminados permanentemente* de Supabase Storage.`;

      await editTelegramMessage(ADMIN_CHAT_ID, messageId, updatedText);
    } else {
      await answerCallbackQuery(cq.id, `⚠️ Error: ${result.error || "Solicitud ya procesada"}`, true);
    }
    return;
  }
});

/**
 * Endpoint de utilidad para configurar el Webhook en Telegram
 */
router.post("/configurar-webhook", async (_req, res) => {
  try {
    const webhookUrl = "https://ya-voy-api.onrender.com/api/telegram/webhook";
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await resp.json();
    res.json({ webhookUrl, telegramResponse: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
