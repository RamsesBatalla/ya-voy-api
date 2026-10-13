import { logError } from "./logger";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8756989292:AAHqQXQTqZBPZuEtY3RSbERf3HMwU5-HVWk";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "1269146838";
export const ADMIN_PHONE_WHATSAPP = "527641311374";
export const ADMIN_TELEGRAM_USER = "ramses_batalla";

/**
 * Envía un mensaje a Telegram del Administrador si las credenciales están configuradas.
 */
export async function sendTelegramAdmin(
  texto: string,
  parseMode: "Markdown" | "HTML" = "Markdown",
  replyMarkup?: any
): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram Notifier - Log Local]:", texto);
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body: any = {
      chat_id: TELEGRAM_CHAT_ID,
      text: texto,
      parse_mode: parseMode,
      disable_web_page_preview: false,
    };
    if (replyMarkup) body.reply_markup = replyMarkup;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (err: any) {
    logError(err, "sendTelegramAdmin");
    return false;
  }
}

/**
 * Genera enlace de WhatsApp prellenado para contactar al administrador o al solicitante
 */
export function buildWhatsAppLink(phone: string, message: string): string {
  const cleanPhone = phone.replace(/\D/g, "");
  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;
}

/**
 * Notificación de Nueva Solicitud de Repartidor
 */
export async function notificarSolicitudRepartidor(datos: {
  solicitud_id?: string;
  usuario_id?: string;
  nombre: string;
  email: string;
  telefono: string;
  vehiculo_tipo: string;
  vehiculo_modelo?: string;
  vehiculo_placas?: string;
  ine_frente?: string;
  ine_reverso?: string;
  selfie?: string;
  tarjeta_url?: string;
}) {
  const mensaje = `🛵 *¡Nueva Solicitud de Repartidor!*\n\n` +
    (datos.usuario_id ? `🆔 *ID Usuario:* \`${datos.usuario_id}\`\n` : "") +
    (datos.solicitud_id ? `📋 *Solicitud ID:* \`${datos.solicitud_id}\`\n` : "") +
    `👤 *Nombre:* ${datos.nombre}\n` +
    `📞 *Teléfono:* [${datos.telefono || "No especificado"}](https://wa.me/${(datos.telefono || "").replace(/\D/g, "")})\n` +
    `✉️ *Correo:* ${datos.email}\n` +
    `🏍️ *Vehículo:* ${datos.vehiculo_tipo.toUpperCase()} ${datos.vehiculo_modelo || ""} ${datos.vehiculo_placas ? `(Placas: ${datos.vehiculo_placas})` : ""}\n\n` +
    `📄 *Documentos (Temporales para Validación):* \n` +
    (datos.ine_frente ? `• [INE Frente](${datos.ine_frente})\n` : "") +
    (datos.ine_reverso ? `• [INE Reverso](${datos.ine_reverso})\n` : "") +
    (datos.selfie ? `• [Selfie / Rostro](${datos.selfie})\n` : "") +
    (datos.tarjeta_url ? `• [Tarjeta de Circulación / Licencia](${datos.tarjeta_url})\n` : "") +
    `\n🔒 *Nota de Privacidad:* Al presionar Aprobar o Rechazar, los documentos de identidad sensibles se eliminarán permanentemente de los servidores.` +
    `\n\n💬 *Admin:* [@${ADMIN_TELEGRAM_USER}](https://t.me/${ADMIN_TELEGRAM_USER}) • [WhatsApp](https://wa.me/${ADMIN_PHONE_WHATSAPP})`;

  const buttons: any[] = [];
  if (datos.solicitud_id) {
    buttons.push([
      { text: "✅ Aprobar Repartidor", callback_data: `aprob_rep:${datos.solicitud_id}` },
      { text: "❌ Rechazar", callback_data: `rech_rep:${datos.solicitud_id}` },
    ]);
  }
  if (datos.telefono) {
    buttons.push([
      { text: "💬 Hablar por WhatsApp", url: `https://wa.me/52${datos.telefono.replace(/\D/g, "")}` }
    ]);
  }

  await sendTelegramAdmin(mensaje, "Markdown", buttons.length > 0 ? { inline_keyboard: buttons } : undefined);
}

/**
 * Notificación de Nueva Solicitud de Restaurante
 */
export async function notificarSolicitudRestaurante(datos: {
  solicitud_id?: string;
  usuario_id?: string;
  nombre_negocio: string;
  contacto_nombre: string;
  email: string;
  telefono: string;
  categoria?: string;
  direccion?: string;
  logo_url?: string;
  ine_frente?: string;
  ine_reverso?: string;
  selfie?: string;
  rfc?: string;
}) {
  const mensaje = `🍳 *¡Nueva Solicitud de Restaurante!*\n\n` +
    (datos.usuario_id ? `🆔 *ID Usuario:* \`${datos.usuario_id}\`\n` : "") +
    (datos.solicitud_id ? `📋 *Solicitud ID:* \`${datos.solicitud_id}\`\n` : "") +
    `🏪 *Negocio:* ${datos.nombre_negocio}\n` +
    `👤 *Contacto:* ${datos.contacto_nombre}\n` +
    `📞 *Teléfono:* [${datos.telefono || "No especificado"}](https://wa.me/${(datos.telefono || "").replace(/\D/g, "")})\n` +
    `✉️ *Correo:* ${datos.email}\n` +
    (datos.categoria ? `🏷️ *Categoría:* ${datos.categoria}\n` : "") +
    (datos.direccion ? `📍 *Dirección:* ${datos.direccion}\n` : "") +
    (datos.rfc ? `📑 *RFC:* \`${datos.rfc}\`\n` : "") +
    `\n📄 *Documentos (Temporales para Validación):* \n` +
    (datos.ine_frente ? `• [INE Frente](${datos.ine_frente})\n` : "") +
    (datos.ine_reverso ? `• [INE Reverso](${datos.ine_reverso})\n` : "") +
    (datos.selfie ? `• [Selfie / Rostro](${datos.selfie})\n` : "") +
    (datos.logo_url ? `• [Logo / Fachada](${datos.logo_url})\n` : "") +
    `\n🔒 *Nota de Privacidad:* Al presionar Aprobar o Rechazar, los documentos sensibles (INE y Selfie) se eliminarán permanentemente de los servidores.` +
    `\n\n💬 *Admin:* [@${ADMIN_TELEGRAM_USER}](https://t.me/${ADMIN_TELEGRAM_USER}) • [WhatsApp](https://wa.me/${ADMIN_PHONE_WHATSAPP})`;

  const buttons: any[] = [];
  if (datos.solicitud_id) {
    buttons.push([
      { text: "✅ Aprobar Restaurante", callback_data: `aprob_res:${datos.solicitud_id}` },
      { text: "❌ Rechazar", callback_data: `rech_res:${datos.solicitud_id}` },
    ]);
  }
  if (datos.telefono) {
    buttons.push([
      { text: "💬 Hablar por WhatsApp", url: `https://wa.me/52${datos.telefono.replace(/\D/g, "")}` }
    ]);
  }

  await sendTelegramAdmin(mensaje, "Markdown", buttons.length > 0 ? { inline_keyboard: buttons } : undefined);
}

/**
 * Notificación de Ticket de Soporte
 */
export async function notificarTicketSoporte(datos: {
  usuarioNombre: string;
  usuarioEmail?: string;
  tipo: string;
  comentario: string;
  pedidoId?: string;
}) {
  const mensaje = `🚨 *Nuevo Ticket de Soporte*\n\n` +
    `👤 *Usuario:* ${datos.usuarioNombre} (${datos.usuarioEmail || "Sin correo"})\n` +
    `📋 *Tipo:* ${datos.tipo}\n` +
    (datos.pedidoId ? `📦 *Pedido ID:* \`${datos.pedidoId}\`\n` : "") +
    `💬 *Mensaje:* ${datos.comentario}\n\n` +
    `💬 *Atender por WhatsApp:* [Abrir Chat](https://wa.me/${ADMIN_PHONE_WHATSAPP})`;

  await sendTelegramAdmin(mensaje);
}

/**
 * Notificación de Solicitud de Retiro de Ganancias
 */
export async function notificarSolicitudRetiro(datos: {
  actorNombre: string;
  tipoActor: string;
  monto: number | string;
  actorId: string;
}) {
  const mensaje = `💰 *Solicitud de Retiro de Ganancias*\n\n` +
    `👤 *Solicitante:* ${datos.actorNombre} (${datos.tipoActor.toUpperCase()})\n` +
    `💵 *Monto:* $${Number(datos.monto).toFixed(2)} MXN\n` +
    `🆔 *ID:* \`${datos.actorId}\`\n\n` +
    `💬 *Admin:* [@${ADMIN_TELEGRAM_USER}](https://t.me/${ADMIN_TELEGRAM_USER})`;

  await sendTelegramAdmin(mensaje);
}
