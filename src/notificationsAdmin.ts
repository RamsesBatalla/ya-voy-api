import { logError } from "./logger";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
export const ADMIN_PHONE_WHATSAPP = "527641311374";
export const ADMIN_TELEGRAM_USER = "Ramses_Batalla";

/**
 * Envía un mensaje a Telegram del Administrador si las credenciales están configuradas.
 */
export async function sendTelegramAdmin(texto: string, parseMode: "Markdown" | "HTML" = "Markdown"): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram Notifier - Log Local]:", texto);
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: texto,
        parse_mode: parseMode,
        disable_web_page_preview: false,
      }),
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
    `👤 *Nombre:* ${datos.nombre}\n` +
    `📞 *Teléfono:* [${datos.telefono || "No especificado"}](https://wa.me/${(datos.telefono || "").replace(/\D/g, "")})\n` +
    `✉️ *Correo:* ${datos.email}\n` +
    `🏍️ *Vehículo:* ${datos.vehiculo_tipo.toUpperCase()} ${datos.vehiculo_modelo || ""} ${datos.vehiculo_placas ? `(Placas: ${datos.vehiculo_placas})` : ""}\n\n` +
    `📄 *Documentos:* \n` +
    (datos.ine_frente ? `• [INE Frente](${datos.ine_frente})\n` : "") +
    (datos.ine_reverso ? `• [INE Reverso](${datos.ine_reverso})\n` : "") +
    (datos.selfie ? `• [Selfie](${datos.selfie})\n` : "") +
    (datos.tarjeta_url ? `• [Tarjeta de Circulación](${datos.tarjeta_url})\n` : "") +
    `\n💬 *Admin:* [@${ADMIN_TELEGRAM_USER}](https://t.me/${ADMIN_TELEGRAM_USER}) • [WhatsApp](https://wa.me/${ADMIN_PHONE_WHATSAPP})`;

  await sendTelegramAdmin(mensaje);
}

/**
 * Notificación de Nueva Solicitud de Restaurante
 */
export async function notificarSolicitudRestaurante(datos: {
  nombre_negocio: string;
  contacto_nombre: string;
  email: string;
  telefono: string;
  categoria?: string;
  direccion?: string;
  logo_url?: string;
}) {
  const mensaje = `🍳 *¡Nueva Solicitud de Restaurante!*\n\n` +
    `🏪 *Negocio:* ${datos.nombre_negocio}\n` +
    `👤 *Contacto:* ${datos.contacto_nombre}\n` +
    `📞 *Teléfono:* [${datos.telefono || "No especificado"}](https://wa.me/${(datos.telefono || "").replace(/\D/g, "")})\n` +
    `✉️ *Correo:* ${datos.email}\n` +
    (datos.categoria ? `🏷️ *Categoría:* ${datos.categoria}\n` : "") +
    (datos.direccion ? `📍 *Dirección:* ${datos.direccion}\n` : "") +
    (datos.logo_url ? `📸 *Foto/Logo:* [Ver Imagen](${datos.logo_url})\n` : "") +
    `\n💬 *Admin:* [@${ADMIN_TELEGRAM_USER}](https://t.me/${ADMIN_TELEGRAM_USER}) • [WhatsApp](https://wa.me/${ADMIN_PHONE_WHATSAPP})`;

  await sendTelegramAdmin(mensaje);
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
