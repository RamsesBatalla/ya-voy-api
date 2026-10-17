import { Router } from "express";
import {
  aprobarRestaurante,
  rechazarRestaurante,
  aprobarRepartidor,
  rechazarRepartidor,
  deleteSupabaseStorageFile,
} from "../services/solicitudesService";
import {
  sendTelegramAdmin,
  escapeHtml,
  notificarSolicitudRepartidor,
  notificarSolicitudRestaurante,
  notificarBloqueoAdmin,
} from "../notificationsAdmin";
import { sql } from "../db";
import { sendPushToUser } from "../firebase";
import { notificarCliente } from "../websocket";
import { logError } from "../logger";

const router = Router();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8756989292:AAHqQXQTqZBPZuEtY3RSbERf3HMwU5-HVWk";
const ADMIN_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "1269146838");

const MOTIVOS_RESTAURANTE: Record<string, string> = {
  ine: "La fotografía de tu identificación (INE) no es legible, tiene reflejos o está recortada. Por favor tómala con buena iluminación.",
  sf: "La fotografía facial (selfie) no es clara o no coincide con los rasgos de la credencial oficial.",
  ub: "La dirección o ubicación en mapa no pudo ser validada o se encuentra fuera de la zona de cobertura.",
  dt: "La información básica de contacto o del negocio está incompleta o no pudimos comunicarnos.",
  ot: "Tu solicitud no cumple con los requisitos vigentes para operar en la red Ya Voy.",
  ine_borrosa: "La fotografía de tu identificación (INE) no es legible, tiene reflejos o está recortada. Por favor tómala con buena iluminación.",
  selfie_invalida: "La fotografía facial (selfie) no es clara o no coincide con los rasgos de la credencial oficial.",
  ubicacion_invalida: "La dirección o ubicación en mapa no pudo ser validada o se encuentra fuera de la zona de cobertura.",
  datos_incompletos: "La información básica de contacto o del negocio está incompleta o no pudimos comunicarnos.",
  otro: "Tu solicitud no cumple con los requisitos vigentes para operar en la red Ya Voy.",
};

const MOTIVOS_REPARTIDOR: Record<string, string> = {
  ine: "La identificación (INE) o licencia de conducir no es legible o está vencida.",
  sf: "La foto de rostro (selfie) no es nítida o no coincide con la credencial.",
  vh: "Los datos del vehículo, placas o tarjeta de circulación presentan inconsistencias.",
  ot: "Tu solicitud no cumple con los requisitos vigentes para repartidores en Ya Voy.",
  ine_borrosa: "La identificación (INE) o licencia de conducir no es legible o está vencida.",
  selfie_invalida: "La foto de rostro (selfie) no es nítida o no coincide con la credencial.",
  vehiculo_invalido: "Los datos del vehículo, placas o tarjeta de circulación presentan inconsistencias.",
  otro: "Tu solicitud no cumple con los requisitos vigentes para repartidores en Ya Voy.",
};

/**
 * Responde a Telegram para quitar el spinner del botón (NOTA: Solo puede llamarse UNA vez por callbackQueryId)
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
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
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
    if (!res.ok) {
      // Si falla la edición de texto, al menos quitamos los botones para evitar doble clic
      await editMessageReplyMarkup(chatId, messageId, { inline_keyboard: buttons || [] });
    }
  } catch (err: any) {
    logError(err, "editTelegramMessage");
  }
}

/**
 * Genera y envía el Panel de Control Operativo en vivo a Telegram
 */
async function enviarResumenAdmin() {
  const [activosRows, repRows, restRows, ventasRows, retirosRows, bloqRows] = await Promise.all([
    sql`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'nuevo') as nuevos, COUNT(*) FILTER (WHERE status IN ('preparando','listo')) as preparando, COUNT(*) FILTER (WHERE status IN ('en_camino','esperando_cliente')) as en_ruta FROM pedidos WHERE status NOT IN ('entregado','cancelado','pendiente_pago')`.catch(() => [{ total: 0, nuevos: 0, preparando: 0, en_ruta: 0 }]),
    sql`SELECT COUNT(*) as online FROM repartidores WHERE (status = 'online' OR en_linea = true) AND COALESCE(bloqueado, false) = false`.catch(() => [{ online: 0 }]),
    sql`SELECT COUNT(*) as abiertos FROM viveres WHERE esta_abierto = true AND COALESCE(status, 'aprobado') = 'aprobado' AND COALESCE(bloqueado, false) = false`.catch(() => [{ abiertos: 0 }]),
    sql`SELECT COUNT(*) as entregados, COALESCE(SUM(total), 0) as monto FROM pedidos WHERE status = 'entregado' AND creado_en >= CURRENT_DATE`.catch(() => [{ entregados: 0, monto: 0 }]),
    sql`SELECT COUNT(*) as pendientes, COALESCE(SUM(monto), 0) as monto FROM retiros WHERE status = 'pendiente'`.catch(() => [{ pendientes: 0, monto: 0 }]),
    sql`SELECT COUNT(*) as sol_pend FROM solicitudes WHERE status = 'pendiente'`.catch(() => [{ sol_pend: 0 }]),
  ]);

  const a = activosRows[0] || {};
  const horaMx = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });

  const msg = `📊 <b>PANEL DE CONTROL YA VOY — EN VIVO</b>\n` +
    `🕒 <i>${horaMx}</i>\n` +
    `══════════════════════════\n` +
    `📦 <b>Pedidos Activos:</b> <b>${a.total || 0}</b>\n` +
    `   • 🔔 Nuevos (por aceptar): ${a.nuevos || 0}\n` +
    `   • 👨‍🍳 En cocina / listos: ${a.preparando || 0}\n` +
    `   • 🛵 En ruta de entrega: ${a.en_ruta || 0}\n\n` +
    `🛵 <b>Repartidores en línea:</b> <b>${repRows[0]?.online || 0}</b>\n` +
    `🏪 <b>Restaurantes abiertos:</b> <b>${restRows[0]?.abiertos || 0}</b>\n` +
    `📋 <b>Solicitudes pendientes:</b> <b>${bloqRows[0]?.sol_pend || 0}</b>\n\n` +
    `💵 <b>Entregas de hoy:</b> ${ventasRows[0]?.entregados || 0} pedidos ($${Number(ventasRows[0]?.monto || 0).toFixed(2)} MXN)\n` +
    `🏦 <b>Retiros por pagar:</b> ${retirosRows[0]?.pendientes || 0} ($${Number(retirosRows[0]?.monto || 0).toFixed(2)} MXN)\n` +
    `══════════════════════════\n` +
    `<i>Comandos disponibles:</i> <code>/resumen</code> • <code>/pendientes</code> • <code>/bloqueados</code>`;

  const buttons = [
    [
      { text: "📋 Ver Solicitudes Pendientes", callback_data: "cmd_pendientes" },
      { text: "🚫 Ver Bloqueados", callback_data: "cmd_bloqueados" },
    ],
    [
      { text: "🔄 Actualizar Panel", callback_data: "cmd_resumen" },
    ]
  ];

  await sendTelegramAdmin(msg, "HTML", { inline_keyboard: buttons });
}

/**
 * Reenvía todas las solicitudes pendientes con sus botones de Aprobar/Rechazar
 */
async function enviarSolicitudesPendientesAdmin() {
  const rows = await sql`SELECT * FROM solicitudes WHERE status = 'pendiente' ORDER BY creado_en DESC LIMIT 15`;
  if (!rows.length) {
    await sendTelegramAdmin("✅ <b>No hay solicitudes pendientes por revisar en este momento.</b>", "HTML");
    return;
  }

  await sendTelegramAdmin(`📋 <b>Encontradas ${rows.length} solicitud(es) pendiente(s):</b>`, "HTML");
  for (const sol of rows) {
    const datos = typeof sol.datos === "string" ? JSON.parse(sol.datos) : (sol.datos || {});
    const docs = typeof sol.documentos === "string" ? JSON.parse(sol.documentos) : (sol.documentos || {});
    if (sol.tipo === "repartidor") {
      await notificarSolicitudRepartidor({
        solicitud_id: String(sol.id),
        usuario_id: sol.usuario_id,
        nombre: datos.nombre || "Repartidor",
        email: datos.email || "",
        telefono: datos.telefono || "",
        vehiculo_tipo: datos.vehiculo_tipo || "moto",
        vehiculo_modelo: datos.vehiculo_modelo,
        vehiculo_placas: datos.vehiculo_placas,
        ine_frente: docs.ine_frente,
        ine_reverso: docs.ine_reverso,
        selfie: docs.selfie,
        tarjeta_url: docs.tarjeta_url,
      });
    } else {
      await notificarSolicitudRestaurante({
        solicitud_id: String(sol.id),
        usuario_id: sol.usuario_id,
        nombre_negocio: datos.nombre_negocio || datos.nombre || "Restaurante",
        contacto_nombre: datos.contacto_nombre || datos.nombre || "",
        email: datos.email || "",
        telefono: datos.telefono || "",
        categoria: datos.tipo_negocio || datos.categoria,
        direccion: datos.direccion,
        logo_url: docs.logo,
        ine_frente: docs.ine_frente,
        ine_reverso: docs.ine_reverso,
        selfie: docs.selfie,
      });
    }
  }
}

/**
 * Envía la lista de cuentas bloqueadas actualmente con botones para Desbloquear o Eliminar
 */
async function enviarBloqueadosAdmin() {
  const [clientes, reps, rests] = await Promise.all([
    sql`SELECT id, nombre, email, telefono, razon_bloqueo FROM usuarios WHERE bloqueado = true LIMIT 10`.catch(() => []),
    sql`SELECT id, nombre, email, telefono, razon_bloqueo FROM repartidores WHERE bloqueado = true LIMIT 10`.catch(() => []),
    sql`SELECT id, nombre, telefono, razon_bloqueo FROM viveres WHERE bloqueado = true OR suspendido = true LIMIT 10`.catch(() => []),
  ]);

  if (!clientes.length && !reps.length && !rests.length) {
    await sendTelegramAdmin("✅ <b>No hay ninguna cuenta bloqueada actualmente.</b>", "HTML");
    return;
  }

  for (const r of reps) {
    await notificarBloqueoAdmin({
      tipoActor: "repartidor",
      actorId: String(r.id),
      nombre: r.nombre,
      telefono: r.telefono,
      email: r.email,
      razon: r.razon_bloqueo || "Bloqueo preventivo",
    });
  }
  for (const v of rests) {
    await notificarBloqueoAdmin({
      tipoActor: "restaurante",
      actorId: String(v.id),
      nombre: v.nombre,
      telefono: v.telefono,
      razon: v.razon_bloqueo || "Suspensión preventiva",
    });
  }
  for (const c of clientes) {
    await notificarBloqueoAdmin({
      tipoActor: "cliente",
      actorId: String(c.id),
      nombre: c.nombre,
      telefono: c.telefono,
      email: c.email,
      razon: c.razon_bloqueo || "Bloqueo preventivo",
    });
  }
}

/**
 * Procesador central de actualizaciones de Telegram (Webhook y Long Polling)
 */
export async function handleTelegramUpdate(update: any) {
  if (!update) return;

  // Manejo de comandos por texto enviados por el Administrador (/resumen, /pendientes, /bloqueados)
  if (update.message && update.message.text) {
    const fromId = String(update.message.from?.id || "");
    if (fromId !== ADMIN_CHAT_ID) return;
    const text = String(update.message.text).trim().toLowerCase();
    if (text.startsWith("/resumen") || text.startsWith("/estado") || text.startsWith("/panel") || text.startsWith("/start")) {
      await enviarResumenAdmin();
    } else if (text.startsWith("/pendientes")) {
      await enviarSolicitudesPendientesAdmin();
    } else if (text.startsWith("/bloqueados")) {
      await enviarBloqueadosAdmin();
    }
    return;
  }

  if (!update.callback_query) return;

  const cq = update.callback_query;
  const fromId = String(cq.from?.id);
  const data = cq.data || "";
  const message = cq.message;
  const messageId = message?.message_id;
  const chatId = message?.chat?.id || ADMIN_CHAT_ID;
  const originalText = escapeHtml(message?.text || "");

  // Seguridad: Solo el Administrador autorizado puede presionar botones
  if (fromId !== ADMIN_CHAT_ID) {
    await answerCallbackQuery(cq.id, "⛔ No estás autorizado para realizar esta acción.", true);
    return;
  }

  // BOTONES DEL PANEL DE CONTROL
  if (data === "cmd_resumen") {
    await answerCallbackQuery(cq.id, "🔄 Actualizando panel...");
    await enviarResumenAdmin();
    return;
  }
  if (data === "cmd_pendientes") {
    await answerCallbackQuery(cq.id, "📋 Consultando solicitudes pendientes...");
    await enviarSolicitudesPendientesAdmin();
    return;
  }
  if (data === "cmd_bloqueados") {
    await answerCallbackQuery(cq.id, "🚫 Consultando cuentas bloqueadas...");
    await enviarBloqueadosAdmin();
    return;
  }

  // 1. APROBAR RESTAURANTE
  if (data.startsWith("aprob_res:")) {
    const solicitudId = data.replace("aprob_res:", "");
    const result = await aprobarRestaurante(solicitudId);

    if (result.ok) {
      await answerCallbackQuery(cq.id, `✅ ¡Restaurante "${result.nombre}" aprobado con éxito! 🎉`, true);

      const horaActual = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
      const updatedText = `${originalText}\n\n` +
        `══════════════════════════\n` +
        `✅ <b>ESTADO: APROBADO</b>\n` +
        `👤 <b>Aprobado por:</b> @${escapeHtml(cq.from.username || "Ramses")}\n` +
        `📅 <b>Fecha:</b> ${horaActual}\n` +
        `🔒 <b>Privacidad:</b> Documentos (INE y Selfie) <i>eliminados permanentemente</i>.`;

      await editTelegramMessage(chatId, messageId, updatedText);
      await sendTelegramAdmin(
        `✅ <b>CONFIRMADO:</b> El restaurante <b>${escapeHtml(result.nombre)}</b> ha sido <b>APROBADO</b> y su cuenta ya está activa en tiempo real en la aplicación.`,
        "HTML"
      );
    } else {
      await answerCallbackQuery(cq.id, `⚠️ Error: ${result.error || "Solicitud no encontrada"}`, true);
      await sendTelegramAdmin(`⚠️ <b>No se pudo aprobar restaurante:</b> ${escapeHtml(result.error || "Solicitud no encontrada")}`, "HTML");
    }
    return;
  }

  // 2. MOSTRAR MENÚ DE MOTIVOS DE RECHAZO (RESTAURANTE)
  if (data.startsWith("rech_res:")) {
    const solicitudId = data.replace("rech_res:", "");
    await answerCallbackQuery(cq.id, "Selecciona el motivo del rechazo:");

    const keyboard = {
      inline_keyboard: [
        [{ text: "📄 INE borrosa o no legible", callback_data: `m_res:${solicitudId}:ine` }],
        [{ text: "👤 Selfie no coincide con INE", callback_data: `m_res:${solicitudId}:sf` }],
        [{ text: "📍 Dirección/ubicación no válida", callback_data: `m_res:${solicitudId}:ub` }],
        [{ text: "📝 Datos de negocio incompletos", callback_data: `m_res:${solicitudId}:dt` }],
        [{ text: "❌ No cumple requisitos (Otro)", callback_data: `m_res:${solicitudId}:ot` }],
        [{ text: "🔙 Cancelar y Volver", callback_data: `v_res:${solicitudId}` }],
      ]
    };

    await editMessageReplyMarkup(chatId, messageId, keyboard);
    return;
  }

  // 3. EJECUTAR RECHAZO CON MOTIVO SELECCIONADO (RESTAURANTE)
  if (data.startsWith("m_res:") || data.startsWith("motivo_res:")) {
    const [, solicitudId, motivoKey] = data.split(":");
    const razon = MOTIVOS_RESTAURANTE[motivoKey] || "Tu solicitud no fue aprobada en este momento. Revisa la información y vuelve a intentar.";

    const result = await rechazarRestaurante(solicitudId, razon);

    if (result.ok) {
      await answerCallbackQuery(cq.id, `❌ Solicitud de "${result.nombre}" rechazada.`, true);

      const horaActual = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
      const updatedText = `${originalText}\n\n` +
        `══════════════════════════\n` +
        `❌ <b>ESTADO: RECHAZADO</b>\n` +
        `📋 <b>Motivo:</b> ${escapeHtml(razon)}\n` +
        `👤 <b>Rechazado por:</b> @${escapeHtml(cq.from.username || "Ramses")}\n` +
        `📅 <b>Fecha:</b> ${horaActual}\n` +
        `🔒 <b>Privacidad:</b> Documentos (INE y Selfie) <i>eliminados permanentemente</i>.`;

      await editTelegramMessage(chatId, messageId, updatedText);
      await sendTelegramAdmin(
        `❌ <b>CONFIRMADO:</b> La solicitud del restaurante <b>${escapeHtml(result.nombre)}</b> fue <b>RECHAZADA</b> y se notificó al solicitante.`,
        "HTML"
      );
    } else {
      await answerCallbackQuery(cq.id, `⚠️ Error: ${result.error || "Solicitud ya procesada"}`, true);
    }
    return;
  }

  // 4. RESTABLECER BOTONES ORIGINALES (RESTAURANTE)
  if (data.startsWith("v_res:") || data.startsWith("volver_res:")) {
    const solicitudId = data.startsWith("v_res:") ? data.replace("v_res:", "") : data.replace("volver_res:", "");
    await answerCallbackQuery(cq.id, "Opciones restablecidas");

    const rows = await sql`SELECT datos FROM solicitudes WHERE id::text = ${solicitudId} OR usuario_id = ${solicitudId} LIMIT 1`;
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
    const result = await aprobarRepartidor(solicitudId);

    if (result.ok) {
      await answerCallbackQuery(cq.id, `✅ ¡Repartidor "${result.nombre}" aprobado con éxito! 🛵`, true);

      const horaActual = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
      const updatedText = `${originalText}\n\n` +
        `══════════════════════════\n` +
        `✅ <b>ESTADO: APROBADO</b>\n` +
        `👤 <b>Aprobado por:</b> @${escapeHtml(cq.from.username || "Ramses")}\n` +
        `📅 <b>Fecha:</b> ${horaActual}\n` +
        `🔒 <b>Privacidad:</b> Documentos de identidad <i>eliminados permanentemente</i>.`;

      await editTelegramMessage(chatId, messageId, updatedText);
      await sendTelegramAdmin(
        `✅ <b>CONFIRMADO:</b> El repartidor <b>${escapeHtml(result.nombre)}</b> ha sido <b>APROBADO</b> y su aplicación ya se activó automáticamente para recibir pedidos. 🛵`,
        "HTML"
      );
    } else {
      await answerCallbackQuery(cq.id, `⚠️ Error al aprobar repartidor: ${result.error || "Solicitud no encontrada"}`, true);
      await sendTelegramAdmin(`⚠️ <b>No se pudo aprobar repartidor:</b> ${escapeHtml(result.error || "Solicitud no encontrada")}`, "HTML");
    }
    return;
  }

  // 6. MOSTRAR MENÚ DE MOTIVOS DE RECHAZO (REPARTIDOR)
  if (data.startsWith("rech_rep:")) {
    const solicitudId = data.replace("rech_rep:", "");
    await answerCallbackQuery(cq.id, "Selecciona el motivo del rechazo:");

    const keyboard = {
      inline_keyboard: [
        [{ text: "📄 INE o Licencia no legible", callback_data: `m_rep:${solicitudId}:ine` }],
        [{ text: "👤 Selfie no coincide con INE", callback_data: `m_rep:${solicitudId}:sf` }],
        [{ text: "🏍️ Datos de vehículo inconsistentes", callback_data: `m_rep:${solicitudId}:vh` }],
        [{ text: "❌ No cumple requisitos (Otro)", callback_data: `m_rep:${solicitudId}:ot` }],
        [{ text: "🔙 Cancelar y Volver", callback_data: `v_rep:${solicitudId}` }],
      ]
    };

    await editMessageReplyMarkup(chatId, messageId, keyboard);
    return;
  }

  // 7. EJECUTAR RECHAZO CON MOTIVO SELECCIONADO (REPARTIDOR)
  if (data.startsWith("m_rep:") || data.startsWith("motivo_rep:")) {
    const [, solicitudId, motivoKey] = data.split(":");
    const razon = MOTIVOS_REPARTIDOR[motivoKey] || "Tu solicitud de repartidor no fue aprobada.";

    const result = await rechazarRepartidor(solicitudId, razon);

    if (result.ok) {
      await answerCallbackQuery(cq.id, `❌ Solicitud de repartidor rechazada.`, true);

      const horaActual = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
      const updatedText = `${originalText}\n\n` +
        `══════════════════════════\n` +
        `❌ <b>ESTADO: RECHAZADO</b>\n` +
        `📋 <b>Motivo:</b> ${escapeHtml(razon)}\n` +
        `👤 <b>Rechazado por:</b> @${escapeHtml(cq.from.username || "Ramses")}\n` +
        `📅 <b>Fecha:</b> ${horaActual}\n` +
        `🔒 <b>Privacidad:</b> Documentos de identidad <i>eliminados permanentemente</i>.`;

      await editTelegramMessage(chatId, messageId, updatedText);
      await sendTelegramAdmin(
        `❌ <b>CONFIRMADO:</b> La solicitud del repartidor <b>${escapeHtml(result.nombre)}</b> fue <b>RECHAZADA</b> y se le envió el motivo a su app.`,
        "HTML"
      );
    } else {
      await answerCallbackQuery(cq.id, `⚠️ Error: ${result.error || "Solicitud ya procesada"}`, true);
    }
    return;
  }

  // 8. RESTABLECER BOTONES ORIGINALES (REPARTIDOR)
  if (data.startsWith("v_rep:") || data.startsWith("volver_rep:")) {
    const solicitudId = data.startsWith("v_rep:") ? data.replace("v_rep:", "") : data.replace("volver_rep:", "");
    await answerCallbackQuery(cq.id, "Opciones restablecidas");

    const rows = await sql`SELECT datos FROM solicitudes WHERE id::text = ${solicitudId} OR usuario_id = ${solicitudId} LIMIT 1`;
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

  // 9. DESBLOQUEAR CUENTA (USUARIO / REPARTIDOR / RESTAURANTE)
  if (data.startsWith("unblk:")) {
    const [, tipoNorm, actorId] = data.split(":");
    try {
      if (tipoNorm === "rep") {
        await sql`UPDATE repartidores SET bloqueado = false, razon_bloqueo = NULL, incidentes_abandono = 0, activo = true, disponible = true WHERE id = ${actorId} OR usuario_id = ${actorId} OR user_id = ${actorId}`;
        await sql`UPDATE usuarios SET bloqueado = false, razon_bloqueo = NULL WHERE id = ${actorId}`.catch(() => {});
      } else if (tipoNorm === "res") {
        await sql`UPDATE viveres SET bloqueado = false, suspendido = false, razon_bloqueo = NULL, incidentes_count = 0, aceptando_pedidos = true WHERE id::text = ${actorId} OR owner_id = ${actorId} OR user_id = ${actorId}`;
        await sql`UPDATE usuarios SET bloqueado = false, razon_bloqueo = NULL WHERE id = ${actorId}`.catch(() => {});
      } else {
        await sql`UPDATE usuarios SET bloqueado = false, bloqueado_pendiente = false, razon_bloqueo = NULL WHERE id = ${actorId}`;
      }
      await sql`UPDATE bloqueos_historial SET resuelto = true, desbloqueado_en = NOW(), nota_desbloqueo = 'Desbloqueado desde Telegram Admin' WHERE actor_id = ${actorId} AND resuelto = false`.catch(() => {});

      notificarCliente(actorId, "cuenta_desbloqueada", { ok: true });
      sendPushToUser(sql, actorId, "🔓 Cuenta reactivada", "Tu cuenta ha sido revisada y desbloqueada por el equipo de Ya Voy.", { tipo: "desbloqueo" }).catch(() => {});

      await answerCallbackQuery(cq.id, "🔓 Cuenta desbloqueada con éxito", true);
      await editTelegramMessage(chatId, messageId, `${originalText}\n\n══════════════════════════\n🔓 <b>ACCIÓN APLICADA: CUENTA DESBLOQUEADA</b>`);
      await sendTelegramAdmin(`🔓 <b>CONFIRMADO:</b> La cuenta <code>${escapeHtml(actorId)}</code> ha sido <b>DESBLOQUEADA</b> y reactivada.`, "HTML");
    } catch (e: any) {
      await answerCallbackQuery(cq.id, `⚠️ Error: ${e.message}`, true);
    }
    return;
  }

  // 10. BLOQUEAR PERMANENTEMENTE
  if (data.startsWith("pblk:")) {
    const [, tipoNorm, actorId] = data.split(":");
    const razonPerm = "Bloqueo permanente confirmado por Administración";
    try {
      if (tipoNorm === "rep") {
        await sql`UPDATE repartidores SET bloqueado = true, razon_bloqueo = ${razonPerm}, en_linea = false, disponible = false, activo = false, status = 'offline' WHERE id = ${actorId} OR usuario_id = ${actorId} OR user_id = ${actorId}`;
        await sql`UPDATE usuarios SET bloqueado = true, razon_bloqueo = ${razonPerm} WHERE id = ${actorId}`.catch(() => {});
      } else if (tipoNorm === "res") {
        await sql`UPDATE viveres SET bloqueado = true, suspendido = true, esta_abierto = false, aceptando_pedidos = false, razon_bloqueo = ${razonPerm} WHERE id::text = ${actorId} OR owner_id = ${actorId} OR user_id = ${actorId}`;
      } else {
        await sql`UPDATE usuarios SET bloqueado = true, razon_bloqueo = ${razonPerm} WHERE id = ${actorId}`;
      }

      await answerCallbackQuery(cq.id, "🚫 Cuenta bloqueada permanentemente", true);
      await editTelegramMessage(chatId, messageId, `${originalText}\n\n══════════════════════════\n🚫 <b>ACCIÓN APLICADA: BLOQUEO PERMANENTE</b>`);
      await sendTelegramAdmin(`🚫 <b>CONFIRMADO:</b> La cuenta <code>${escapeHtml(actorId)}</code> quedó <b>BLOQUEADA PERMANENTEMENTE</b>.`, "HTML");
    } catch (e: any) {
      await answerCallbackQuery(cq.id, `⚠️ Error: ${e.message}`, true);
    }
    return;
  }

  // 11. ELIMINAR CUENTA DEFINITIVAMENTE DESDE TELEGRAM
  if (data.startsWith("delacc:")) {
    const [, tipoNorm, actorId] = data.split(":");
    try {
      // Limpiar archivos en Supabase Storage si existen
      const uRows = await sql`SELECT foto_url, foto_perfil FROM usuarios WHERE id = ${actorId}`.catch(() => []);
      for (const u of uRows) {
        if (u.foto_url) await deleteSupabaseStorageFile(u.foto_url);
        if (u.foto_perfil) await deleteSupabaseStorageFile(u.foto_perfil);
      }
      if (tipoNorm === "res") {
        const vRows = await sql`SELECT id, owner_id, logo_url, imagen_url, banner_url FROM viveres WHERE id::text = ${actorId} OR owner_id = ${actorId} LIMIT 1`.catch(() => []);
        if (vRows[0]) {
          await deleteSupabaseStorageFile(vRows[0].logo_url);
          await deleteSupabaseStorageFile(vRows[0].imagen_url);
          await deleteSupabaseStorageFile(vRows[0].banner_url);
          await sql`DELETE FROM viveres WHERE id = ${vRows[0].id}`.catch(() => {});
          if (vRows[0].owner_id) {
            await sql`DELETE FROM solicitudes WHERE usuario_id = ${vRows[0].owner_id}`.catch(() => {});
            await sql`DELETE FROM usuarios WHERE id = ${vRows[0].owner_id}`.catch(() => {});
          }
        }
      } else {
        await sql`DELETE FROM repartidores WHERE id = ${actorId} OR usuario_id = ${actorId} OR user_id = ${actorId}`.catch(() => {});
        await sql`DELETE FROM direcciones WHERE usuario_id = ${actorId}`.catch(() => {});
        await sql`DELETE FROM device_tokens WHERE user_id = ${actorId}`.catch(() => {});
        await sql`DELETE FROM solicitudes WHERE usuario_id = ${actorId}`.catch(() => {});
        await sql`DELETE FROM usuarios WHERE id = ${actorId}`.catch(() => {});
      }

      await answerCallbackQuery(cq.id, "🗑 Cuenta eliminada permanentemente", true);
      await editTelegramMessage(chatId, messageId, `${originalText}\n\n══════════════════════════\n🗑 <b>ACCIÓN APLICADA: CUENTA ELIMINADA DE RAÍZ</b>`);
      await sendTelegramAdmin(`🗑 <b>CONFIRMADO:</b> La cuenta <code>${escapeHtml(actorId)}</code> y sus archivos fueron <b>ELIMINADOS PERMANENTEMENTE</b>.`, "HTML");
    } catch (e: any) {
      await answerCallbackQuery(cq.id, `⚠️ Error: ${e.message}`, true);
    }
    return;
  }

  // 12. CONFIRMAR PAGO DE RETIRO BANCARIO DESDE TELEGRAM
  if (data.startsWith("pag_ret:")) {
    const retiroId = data.replace("pag_ret:", "");
    try {
      const rows = await sql`
        UPDATE retiros
        SET status = 'pagado', fecha_pago = NOW(), nota_admin = 'Transferencia SPEI confirmada desde Telegram'
        WHERE id::text = ${retiroId} AND status = 'pendiente'
        RETURNING *
      `;
      if (!rows.length) {
        await answerCallbackQuery(cq.id, "Este retiro ya fue procesado anteriormente.", true);
        return;
      }
      const r = rows[0];
      sendPushToUser(
        sql,
        r.actor_id,
        "💸 ¡Retiro bancario depositado!",
        `Tu retiro por $${Number(r.monto).toFixed(2)} MXN ha sido transferido a tu cuenta CLABE.`,
        { tipo: "retiro_pagado" }
      ).catch(() => {});

      await answerCallbackQuery(cq.id, "✅ Retiro marcado como pagado", true);
      await editTelegramMessage(chatId, messageId, `${originalText}\n\n══════════════════════════\n✅ <b>TRANSFERENCIA PAGADA ($${Number(r.monto).toFixed(2)} MXN)</b>`);
      await sendTelegramAdmin(`✅ <b>CONFIRMADO:</b> Retiro de <b>$${Number(r.monto).toFixed(2)} MXN</b> para <b>${escapeHtml(r.actor_nombre || r.actor_id)}</b> marcado como pagado.`, "HTML");
    } catch (e: any) {
      await answerCallbackQuery(cq.id, `⚠️ Error: ${e.message}`, true);
    }
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

