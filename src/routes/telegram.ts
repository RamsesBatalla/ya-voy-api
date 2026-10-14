import { Router } from "express";
import {
  aprobarRestaurante,
  rechazarRestaurante,
  aprobarRepartidor,
  rechazarRepartidor,
} from "../services/solicitudesService";
import { sql } from "../db";
import { logError } from "../logger";

const router = Router();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8756989292:AAHqQXQTqZBPZuEtY3RSbERf3HMwU5-HVWk";
const ADMIN_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "1269146838");

const MOTIVOS_RESTAURANTE: Record<string, string> = {
  ine_borrosa: "La fotografía de tu identificación (INE) no es legible, tiene reflejos o está recortada. Por favor tómala con buena iluminación.",
  selfie_invalida: "La fotografía facial (selfie) no es clara o no coincide con los rasgos de la credencial oficial.",
  ubicacion_invalida: "La dirección o ubicación en mapa no pudo ser validada o se encuentra fuera de la zona de cobertura.",
  datos_incompletos: "La información básica de contacto o del negocio está incompleta o no pudimos comunicarnos.",
  otro: "Tu solicitud no cumple con los requisitos vigentes para operar en la red Ya Voy.",
};

const MOTIVOS_REPARTIDOR: Record<string, string> = {
  ine_borrosa: "La identificación (INE) o licencia de conducir no es legible o está vencida.",
  selfie_invalida: "La foto de rostro (selfie) no es nítida o no coincide con la credencial.",
  vehiculo_invalido: "Los datos del vehículo, placas o tarjeta de circulación presentan inconsistencias.",
  otro: "Tu solicitud no cumple con los requisitos vigentes para repartidores en Ya Voy.",
};

/**
 * Responde a Telegram para quitar el spinner del botón
 */
export async function answerCallbackQuery(callbackQueryId: string, text: string, showAlert = false) {
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
 * Modifica el teclado interactivo en Telegram
 */
export async function editMessageReplyMarkup(chatId: string | number, messageId: number, replyMarkup: any) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      }),
    });
  } catch (err: any) {
    logError(err, "editMessageReplyMarkup");
  }
}

/**
 * Modifica el mensaje en Telegram para mostrar el nuevo estado
 */
export async function editTelegramMessage(chatId: string | number, messageId: number, newText: string, buttons?: any) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: newText,
        parse_mode: "HTML",
        reply_markup: buttons ? { inline_keyboard: buttons } : { inline_keyboard: [] },
      }),
    });
  } catch (err: any) {
    logError(err, "editTelegramMessage");
  }
}

/**
 * Procesador central de actualizaciones de Telegram (Webhook y Long Polling)
 */
export async function handleTelegramUpdate(update: any) {
  if (!update || !update.callback_query) return;

  const cq = update.callback_query;
  const fromId = String(cq.from?.id);
  const data = cq.data || "";
  const message = cq.message;
  const messageId = message?.message_id;
  const chatId = message?.chat?.id || ADMIN_CHAT_ID;
  const originalText = message?.text || "";

  // Seguridad: Solo el Administrador autorizado puede presionar botones
  if (fromId !== ADMIN_CHAT_ID) {
    await answerCallbackQuery(cq.id, "⛔ No estás autorizado para realizar esta acción.", true);
    return;
  }

  // 1. APROBAR RESTAURANTE
  if (data.startsWith("aprob_res:")) {
    const solicitudId = data.replace("aprob_res:", "");
    await answerCallbackQuery(cq.id, "⏳ Aprobando restaurante...");
    const result = await aprobarRestaurante(solicitudId);

    if (result.ok) {
      await answerCallbackQuery(cq.id, `✅ ¡"${result.nombre}" ha sido aprobado con éxito! 🎉`);

      const horaActual = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
      const updatedText = `${originalText}\n\n` +
        `══════════════════════════\n` +
        `✅ <b>ESTADO: APROBADO</b>\n` +
        `👤 <b>Aprobado por:</b> @${cq.from.username || "Ramses"}\n` +
        `📅 <b>Fecha:</b> ${horaActual}\n` +
        `🔒 <b>Privacidad:</b> Documentos (INE y Selfie) <i>eliminados permanentemente</i>.`;

      await editTelegramMessage(chatId, messageId, updatedText);
    } else {
      await answerCallbackQuery(cq.id, `⚠️ Error: ${result.error || "Solicitud ya procesada"}`, true);
    }
    return;
  }

  // 2. MOSTRAR MENÚ DE MOTIVOS DE RECHAZO (RESTAURANTE)
  if (data.startsWith("rech_res:")) {
    const solicitudId = data.replace("rech_res:", "");
    await answerCallbackQuery(cq.id, "Selecciona el motivo del rechazo:");

    const keyboard = {
      inline_keyboard: [
        [{ text: "📄 INE borrosa o no legible", callback_data: `motivo_res:${solicitudId}:ine_borrosa` }],
        [{ text: "👤 Selfie no coincide con INE", callback_data: `motivo_res:${solicitudId}:selfie_invalida` }],
        [{ text: "📍 Dirección/ubicación no válida", callback_data: `motivo_res:${solicitudId}:ubicacion_invalida` }],
        [{ text: "📝 Datos de negocio incompletos", callback_data: `motivo_res:${solicitudId}:datos_incompletos` }],
        [{ text: "❌ No cumple requisitos (Otro)", callback_data: `motivo_res:${solicitudId}:otro` }],
        [{ text: "🔙 Cancelar y Volver", callback_data: `volver_res:${solicitudId}` }],
      ]
    };

    await editMessageReplyMarkup(chatId, messageId, keyboard);
    return;
  }

  // 3. EJECUTAR RECHAZO CON MOTIVO SELECCIONADO (RESTAURANTE)
  if (data.startsWith("motivo_res:")) {
    const [, solicitudId, motivoKey] = data.split(":");
    const razon = MOTIVOS_RESTAURANTE[motivoKey] || "Tu solicitud no fue aprobada en este momento. Revisa la información y vuelve a intentar.";

    await answerCallbackQuery(cq.id, "⏳ Rechazando solicitud...");
    const result = await rechazarRestaurante(solicitudId, razon);

    if (result.ok) {
      await answerCallbackQuery(cq.id, `❌ Solicitud rechazada.`);

      const horaActual = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
      const updatedText = `${originalText}\n\n` +
        `══════════════════════════\n` +
        `❌ <b>ESTADO: RECHAZADO</b>\n` +
        `📋 <b>Motivo:</b> ${razon}\n` +
        `👤 <b>Rechazado por:</b> @${cq.from.username || "Ramses"}\n` +
        `📅 <b>Fecha:</b> ${horaActual}\n` +
        `🔒 <b>Privacidad:</b> Documentos (INE y Selfie) <i>eliminados permanentemente</i>.`;

      await editTelegramMessage(chatId, messageId, updatedText);
    } else {
      await answerCallbackQuery(cq.id, `⚠️ Error: ${result.error || "Solicitud ya procesada"}`, true);
    }
    return;
  }

  // 4. RESTABLECER BOTONES ORIGINALES (RESTAURANTE)
  if (data.startsWith("volver_res:")) {
    const solicitudId = data.replace("volver_res:", "");
    await answerCallbackQuery(cq.id, "Opciones restablecidas");

    const rows = await sql`SELECT datos FROM solicitudes WHERE id = ${solicitudId}`;
    const cleanPhone = (rows[0]?.datos?.telefono || "").replace(/\D/g, "");
    const waUrl = cleanPhone ? `https://wa.me/${cleanPhone.startsWith("52") ? cleanPhone : "52" + cleanPhone}` : null;

    const buttons: any[] = [
      [
        { text: "✅ Aprobar Restaurante", callback_data: `aprob_res:${solicitudId}` },
        { text: "❌ Rechazar", callback_data: `rech_res:${solicitudId}` },
      ]
    ];
    if (waUrl) {
      buttons.push([{ text: "💬 Hablar por WhatsApp", url: waUrl }]);
    }

    await editMessageReplyMarkup(chatId, messageId, { inline_keyboard: buttons });
    return;
  }

  // 5. APROBAR REPARTIDOR
  if (data.startsWith("aprob_rep:")) {
    const solicitudId = data.replace("aprob_rep:", "");
    await answerCallbackQuery(cq.id, "⏳ Aprobando repartidor...");
    const result = await aprobarRepartidor(solicitudId);

    if (result.ok) {
      await answerCallbackQuery(cq.id, `✅ ¡Repartidor "${result.nombre}" aprobado con éxito! 🛵`);

      const horaActual = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
      const updatedText = `${originalText}\n\n` +
        `══════════════════════════\n` +
        `✅ <b>ESTADO: APROBADO</b>\n` +
        `👤 <b>Aprobado por:</b> @${cq.from.username || "Ramses"}\n` +
        `📅 <b>Fecha:</b> ${horaActual}\n` +
        `🔒 <b>Privacidad:</b> Documentos de identidad <i>eliminados permanentemente</i>.`;

      await editTelegramMessage(chatId, messageId, updatedText);
    } else {
      await answerCallbackQuery(cq.id, `⚠️ Error al aprobar repartidor: ${result.error || "Solicitud ya procesada"}`, true);
    }
    return;
  }

  // 6. MOSTRAR MENÚ DE MOTIVOS DE RECHAZO (REPARTIDOR)
  if (data.startsWith("rech_rep:")) {
    const solicitudId = data.replace("rech_rep:", "");
    await answerCallbackQuery(cq.id, "Selecciona el motivo del rechazo:");

    const keyboard = {
      inline_keyboard: [
        [{ text: "📄 INE o Licencia no legible", callback_data: `motivo_rep:${solicitudId}:ine_borrosa` }],
        [{ text: "👤 Selfie no coincide con INE", callback_data: `motivo_rep:${solicitudId}:selfie_invalida` }],
        [{ text: "🏍️ Datos de vehículo inconsistentes", callback_data: `motivo_rep:${solicitudId}:vehiculo_invalido` }],
        [{ text: "❌ No cumple requisitos (Otro)", callback_data: `motivo_rep:${solicitudId}:otro` }],
        [{ text: "🔙 Cancelar y Volver", callback_data: `volver_rep:${solicitudId}` }],
      ]
    };

    await editMessageReplyMarkup(chatId, messageId, keyboard);
    return;
  }

  // 7. EJECUTAR RECHAZO CON MOTIVO SELECCIONADO (REPARTIDOR)
  if (data.startsWith("motivo_rep:")) {
    const [, solicitudId, motivoKey] = data.split(":");
    const razon = MOTIVOS_REPARTIDOR[motivoKey] || "Tu solicitud de repartidor no fue aprobada.";

    await answerCallbackQuery(cq.id, "⏳ Rechazando repartidor...");
    const result = await rechazarRepartidor(solicitudId, razon);

    if (result.ok) {
      await answerCallbackQuery(cq.id, `❌ Solicitud de repartidor rechazada.`);

      const horaActual = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
      const updatedText = `${originalText}\n\n` +
        `══════════════════════════\n` +
        `❌ <b>ESTADO: RECHAZADO</b>\n` +
        `📋 <b>Motivo:</b> ${razon}\n` +
        `👤 <b>Rechazado por:</b> @${cq.from.username || "Ramses"}\n` +
        `📅 <b>Fecha:</b> ${horaActual}\n` +
        `🔒 <b>Privacidad:</b> Documentos de identidad <i>eliminados permanentemente</i>.`;

      await editTelegramMessage(chatId, messageId, updatedText);
    } else {
      await answerCallbackQuery(cq.id, `⚠️ Error: ${result.error || "Solicitud ya procesada"}`, true);
    }
    return;
  }

  // 8. RESTABLECER BOTONES ORIGINALES (REPARTIDOR)
  if (data.startsWith("volver_rep:")) {
    const solicitudId = data.replace("volver_rep:", "");
    await answerCallbackQuery(cq.id, "Opciones restablecidas");

    const rows = await sql`SELECT datos FROM solicitudes WHERE id = ${solicitudId}`;
    const cleanPhone = (rows[0]?.datos?.telefono || "").replace(/\D/g, "");
    const waUrl = cleanPhone ? `https://wa.me/${cleanPhone.startsWith("52") ? cleanPhone : "52" + cleanPhone}` : null;

    const buttons: any[] = [
      [
        { text: "✅ Aprobar Repartidor", callback_data: `aprob_rep:${solicitudId}` },
        { text: "❌ Rechazar", callback_data: `rech_rep:${solicitudId}` },
      ]
    ];
    if (waUrl) {
      buttons.push([{ text: "💬 Hablar por WhatsApp", url: waUrl }]);
    }

    await editMessageReplyMarkup(chatId, messageId, { inline_keyboard: buttons });
    return;
  }
}

/**
 * Webhook de Telegram para recibir interacciones de botones
 */
router.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (update) {
    handleTelegramUpdate(update).catch(err => logError(err, "webhook:handleTelegramUpdate"));
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

let isPolling = false;

/**
 * Long-polling para escuchar botones sin depender de la configuración o despertar de webhooks
 */
export async function startTelegramPolling() {
  if (isPolling) return;
  isPolling = true;

  console.log("🤖 Telegram: Iniciando Polling Listener...");
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`, { method: "POST" }).catch(() => {});

  let offset = 0;
  while (isPolling) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=20`);
      const data: any = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          await handleTelegramUpdate(update).catch(e => logError(e, "polling:handleTelegramUpdate"));
        }
      } else {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

export default router;
