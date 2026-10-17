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

export function escapeHtml(text?: string | null): string {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  const cleanPhone = (datos.telefono || "").replace(/\D/g, "");
  const waUrl = cleanPhone.startsWith("52") || cleanPhone.startsWith("1")
    ? `https://wa.me/${cleanPhone}`
    : `https://wa.me/52${cleanPhone}`;

  let mensaje = `🛵 <b>¡Nueva Solicitud de Repartidor!</b>\n\n`;
  if (datos.usuario_id) mensaje += `🆔 <b>ID Usuario:</b> <code>${escapeHtml(datos.usuario_id)}</code>\n`;
  if (datos.solicitud_id) mensaje += `📋 <b>Solicitud ID:</b> <code>${escapeHtml(datos.solicitud_id)}</code>\n`;
  mensaje += `👤 <b>Nombre:</b> ${escapeHtml(datos.nombre)}\n`;
  mensaje += `📞 <b>Teléfono:</b> <a href="${waUrl}">${escapeHtml(datos.telefono || "No especificado")}</a>\n`;
  mensaje += `✉️ <b>Correo:</b> ${escapeHtml(datos.email)}\n`;
  mensaje += `🏍️ <b>Vehículo:</b> ${escapeHtml(datos.vehiculo_tipo.toUpperCase())} ${escapeHtml(datos.vehiculo_modelo || "")} ${datos.vehiculo_placas ? `(Placas: ${escapeHtml(datos.vehiculo_placas)})` : ""}\n\n`;

  mensaje += `📄 <b>Documentos (Temporales para Validación):</b>\n`;
  if (datos.ine_frente) mensaje += `• <a href="${datos.ine_frente}">INE Frente</a>\n`;
  if (datos.ine_reverso) mensaje += `• <a href="${datos.ine_reverso}">INE Reverso</a>\n`;
  if (datos.selfie) mensaje += `• <a href="${datos.selfie}">Selfie / Rostro</a>\n`;
  if (datos.tarjeta_url) mensaje += `• <a href="${datos.tarjeta_url}">Tarjeta de Circulación / Licencia</a>\n`;

  mensaje += `\n🔒 <i>Nota de Privacidad: Al presionar Aprobar o Rechazar, los documentos de identidad sensibles se eliminarán permanentemente de los servidores.</i>\n\n`;
  mensaje += `💬 <b>Admin:</b> <a href="https://t.me/${ADMIN_TELEGRAM_USER}">@${ADMIN_TELEGRAM_USER}</a> • <a href="https://wa.me/${ADMIN_PHONE_WHATSAPP}">WhatsApp</a>`;

  const targetId = datos.solicitud_id || datos.usuario_id || "";
  const buttons: any[] = [];
  if (targetId) {
    buttons.push([
      { text: "✅ Aprobar Repartidor", callback_data: `aprob_rep:${targetId}` },
      { text: "❌ Rechazar", callback_data: `rech_rep:${targetId}` },
    ]);
  }
  if (cleanPhone) {
    buttons.push([
      { text: "💬 Hablar por WhatsApp", url: waUrl }
    ]);
  }

  await sendTelegramAdmin(mensaje, "HTML", buttons.length > 0 ? { inline_keyboard: buttons } : undefined);
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
  const cleanPhone = (datos.telefono || "").replace(/\D/g, "");
  const waUrl = cleanPhone.startsWith("52") || cleanPhone.startsWith("1")
    ? `https://wa.me/${cleanPhone}`
    : `https://wa.me/52${cleanPhone}`;

  let mensaje = `🍳 <b>¡Nueva Solicitud de Restaurante!</b>\n\n`;
  if (datos.usuario_id) mensaje += `🆔 <b>ID Usuario:</b> <code>${escapeHtml(datos.usuario_id)}</code>\n`;
  if (datos.solicitud_id) mensaje += `📋 <b>Solicitud ID:</b> <code>${escapeHtml(datos.solicitud_id)}</code>\n`;
  mensaje += `🏪 <b>Negocio:</b> ${escapeHtml(datos.nombre_negocio)}\n`;
  mensaje += `👤 <b>Contacto:</b> ${escapeHtml(datos.contacto_nombre)}\n`;
  mensaje += `📞 <b>Teléfono:</b> <a href="${waUrl}">${escapeHtml(datos.telefono || "No especificado")}</a>\n`;
  mensaje += `✉️ <b>Correo:</b> ${escapeHtml(datos.email)}\n`;
  if (datos.categoria) mensaje += `🏷️ <b>Categoría:</b> ${escapeHtml(datos.categoria)}\n`;
  if (datos.direccion) mensaje += `📍 <b>Dirección:</b> ${escapeHtml(datos.direccion)}\n`;
  if (datos.rfc) mensaje += `📑 <b>RFC:</b> <code>${escapeHtml(datos.rfc)}</code>\n`;

  mensaje += `\n📄 <b>Documentos (Temporales para Validación):</b>\n`;
  if (datos.ine_frente) mensaje += `• <a href="${datos.ine_frente}">INE Frente</a>\n`;
  if (datos.ine_reverso) mensaje += `• <a href="${datos.ine_reverso}">INE Reverso</a>\n`;
  if (datos.selfie) mensaje += `• <a href="${datos.selfie}">Selfie / Rostro</a>\n`;
  if (datos.logo_url) mensaje += `• <a href="${datos.logo_url}">Logo / Fachada</a>\n`;

  mensaje += `\n🔒 <i>Nota de Privacidad: Al presionar Aprobar o Rechazar, los documentos sensibles (INE y Selfie) se eliminarán permanentemente de los servidores.</i>\n\n`;
  mensaje += `💬 <b>Admin:</b> <a href="https://t.me/${ADMIN_TELEGRAM_USER}">@${ADMIN_TELEGRAM_USER}</a> • <a href="https://wa.me/${ADMIN_PHONE_WHATSAPP}">WhatsApp</a>`;

  const targetId = datos.solicitud_id || datos.usuario_id || "";
  const buttons: any[] = [];
  if (targetId) {
    buttons.push([
      { text: "✅ Aprobar Restaurante", callback_data: `aprob_res:${targetId}` },
      { text: "❌ Rechazar", callback_data: `rech_res:${targetId}` },
    ]);
  }
  if (cleanPhone) {
    buttons.push([
      { text: "💬 Hablar por WhatsApp", url: waUrl }
    ]);
  }

  await sendTelegramAdmin(mensaje, "HTML", buttons.length > 0 ? { inline_keyboard: buttons } : undefined);
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
  const mensaje = `🚨 <b>Nuevo Ticket de Soporte</b>\n\n` +
    `👤 <b>Usuario:</b> ${escapeHtml(datos.usuarioNombre)} (${escapeHtml(datos.usuarioEmail || "Sin correo")})\n` +
    `📋 <b>Tipo:</b> ${escapeHtml(datos.tipo)}\n` +
    (datos.pedidoId ? `📦 <b>Pedido ID:</b> <code>${escapeHtml(datos.pedidoId)}</code>\n` : "") +
    `💬 <b>Mensaje:</b> ${escapeHtml(datos.comentario)}\n\n` +
    `💬 <b>Atender por WhatsApp:</b> <a href="https://wa.me/${ADMIN_PHONE_WHATSAPP}">Abrir Chat</a>`;

  await sendTelegramAdmin(mensaje, "HTML");
}

/**
 * Notificación de Solicitud de Retiro de Ganancias
 */
export async function notificarSolicitudRetiro(datos: {
  retiroId?: string;
  actorNombre: string;
  tipoActor: string;
  monto: number | string;
  actorId: string;
  clabe?: string | null;
  banco?: string | null;
  titular?: string | null;
}) {
  let mensaje = `💰 <b>Solicitud de Retiro Bancario (CLABE)</b>\n\n` +
    `👤 <b>Solicitante:</b> ${escapeHtml(datos.actorNombre)} (${escapeHtml(datos.tipoActor.toUpperCase())})\n` +
    `💵 <b>Monto a transferir:</b> <b>$${Number(datos.monto).toFixed(2)} MXN</b>\n` +
    `🆔 <b>ID Actor:</b> <code>${escapeHtml(datos.actorId)}</code>\n`;

  if (datos.banco) mensaje += `🏦 <b>Banco:</b> ${escapeHtml(datos.banco)}\n`;
  if (datos.titular) mensaje += `👤 <b>Titular:</b> ${escapeHtml(datos.titular)}\n`;
  if (datos.clabe) mensaje += `🔢 <b>CLABE:</b> <code>${escapeHtml(datos.clabe)}</code>\n`;

  const buttons: any[] = [];
  if (datos.retiroId) {
    buttons.push([
      { text: "✅ Confirmar Transferencia Pagada", callback_data: `pag_ret:${datos.retiroId}` },
    ]);
  }

  await sendTelegramAdmin(mensaje, "HTML", buttons.length > 0 ? { inline_keyboard: buttons } : undefined);
}

/**
 * Alerta de Bloqueo Preventivo o Automático con Botones de Acción para el Administrador
 */
export async function notificarBloqueoAdmin(datos: {
  tipoActor: "cliente" | "repartidor" | "restaurante" | string;
  actorId: string;
  nombre?: string;
  telefono?: string;
  email?: string;
  razon: string;
  pedidoId?: string;
}) {
  const tipoNorm = datos.tipoActor === "restaurante" || datos.tipoActor === "negocio"
    ? "res"
    : datos.tipoActor === "repartidor"
      ? "rep"
      : "cli";

  const etiqueta = tipoNorm === "res" ? "RESTAURANTE" : tipoNorm === "rep" ? "REPARTIDOR" : "CLIENTE";
  const emoji = tipoNorm === "res" ? "🏪" : tipoNorm === "rep" ? "🛵" : "👤";

  let mensaje = `🚨 <b>ALERTA DE BLOQUEO DE CUENTA (${etiqueta})</b>\n\n` +
    `${emoji} <b>Nombre:</b> ${escapeHtml(datos.nombre || "Sin nombre")}\n` +
    `🆔 <b>ID:</b> <code>${escapeHtml(datos.actorId)}</code>\n`;

  if (datos.telefono) mensaje += `📞 <b>Teléfono:</b> ${escapeHtml(datos.telefono)}\n`;
  if (datos.email) mensaje += `✉️ <b>Email:</b> ${escapeHtml(datos.email)}\n`;
  if (datos.pedidoId) mensaje += `📦 <b>Pedido relacionado:</b> <code>#${escapeHtml(String(datos.pedidoId).slice(-6).toUpperCase())}</code>\n`;
  mensaje += `⚠️ <b>Motivo del bloqueo:</b> ${escapeHtml(datos.razon)}\n\n` +
    `<i>Selecciona qué acción deseas aplicar sobre esta cuenta:</i>`;

  // Telegram callback_data limit is 64 bytes: unblk:rep:<36-char-uuid> = 46 bytes
  const buttons: any[] = [
    [
      { text: "🔓 Desbloquear Cuenta", callback_data: `unblk:${tipoNorm}:${datos.actorId}` },
    ],
    [
      { text: "🚫 Bloquear Permanente", callback_data: `pblk:${tipoNorm}:${datos.actorId}` },
      { text: "🗑 Eliminar Cuenta", callback_data: `delacc:${tipoNorm}:${datos.actorId}` },
    ]
  ];

  const cleanPhone = (datos.telefono || "").replace(/\D/g, "");
  if (cleanPhone) {
    const waUrl = cleanPhone.startsWith("52") || cleanPhone.startsWith("1")
      ? `https://wa.me/${cleanPhone}`
      : `https://wa.me/52${cleanPhone}`;
    buttons.push([{ text: "💬 Contactar por WhatsApp", url: waUrl }]);
  }

  await sendTelegramAdmin(mensaje, "HTML", { inline_keyboard: buttons });
}

/**
 * Alerta de Contingencia Operativa en Tiempo Real
 */
export async function notificarContingenciaAdmin(datos: {
  titulo: string;
  pedidoId: string;
  detalle: string;
  actorTipo?: "cliente" | "repartidor" | "restaurante";
  actorId?: string;
  actorNombre?: string;
  fotoEvidenciaUrl?: string | null;
}) {
  let mensaje = `⚠️ <b>CONTINGENCIA OPERATIVA: ${escapeHtml(datos.titulo)}</b>\n\n` +
    `📦 <b>Pedido:</b> <code>#${escapeHtml(String(datos.pedidoId).slice(-6).toUpperCase())}</code> (ID: <code>${escapeHtml(datos.pedidoId)}</code>)\n`;

  if (datos.actorNombre || datos.actorId) {
    mensaje += `👤 <b>Involucrado (${escapeHtml(datos.actorTipo || "actor")}):</b> ${escapeHtml(datos.actorNombre || "")} <code>${escapeHtml(datos.actorId || "")}</code>\n`;
  }
  mensaje += `📋 <b>Detalle:</b> ${escapeHtml(datos.detalle)}\n`;
  if (datos.fotoEvidenciaUrl) {
    mensaje += `📸 <b>Evidencia fotográfica:</b> <a href="${datos.fotoEvidenciaUrl}">Ver foto de evidencia</a>\n`;
  }

  const buttons: any[] = [];
  if (datos.actorId && datos.actorTipo) {
    const tipoNorm = datos.actorTipo === "restaurante" ? "res" : datos.actorTipo === "repartidor" ? "rep" : "cli";
    buttons.push([
      { text: "🔓 Desbloquear", callback_data: `unblk:${tipoNorm}:${datos.actorId}` },
      { text: "🚫 Bloquear Permanente", callback_data: `pblk:${tipoNorm}:${datos.actorId}` },
    ]);
  }

  await sendTelegramAdmin(mensaje, "HTML", buttons.length > 0 ? { inline_keyboard: buttons } : undefined);
}

