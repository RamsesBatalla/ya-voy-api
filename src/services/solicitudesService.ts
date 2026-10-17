import { sql, supabase } from "../db";
import { sendPushToUser } from "../firebase";
import { notificarCliente } from "../websocket";
import { logError } from "../logger";

/**
 * Extrae el bucket y el path relativo de una URL pública de Supabase Storage.
 * Ejemplo: https://qqwpfypjwdetljyzkogo.supabase.co/storage/v1/object/public/restaurantes/documentos/user123/ine_frente_123.jpg
 * Devuelve: { bucket: 'restaurantes', path: 'documentos/user123/ine_frente_123.jpg' }
 */
export function parseSupabaseStorageUrl(url: string | null | undefined): { bucket: string; path: string } | null {
  if (!url || typeof url !== "string") return null;
  const match = url.match(/\/storage\/v1\/object\/(?:public\/)?([^\/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], path: match[2] };
}

/**
 * Elimina físicamente un archivo de Supabase Storage.
 */
export async function deleteSupabaseStorageFile(url: string | null | undefined): Promise<boolean> {
  const parsed = parseSupabaseStorageUrl(url);
  if (!parsed) return false;
  try {
    const { error } = await supabase.storage.from(parsed.bucket).remove([parsed.path]);
    if (error) {
      console.warn(`[StorageCleanup] Error deleting ${parsed.path} from ${parsed.bucket}:`, error.message);
      return false;
    }
    console.log(`[StorageCleanup] Deleted ${parsed.path} from ${parsed.bucket}`);
    return true;
  } catch (err: any) {
    logError(err, "deleteSupabaseStorageFile");
    return false;
  }
}

/**
 * Elimina de raíz todos los documentos sensibles (INE frente/reverso, selfie, licencia)
 * de Supabase Storage y limpia el campo documentos en PostgreSQL para cumplimiento de privacidad.
 */
export async function purgeSolicitudSensitiveDocs(solicitudId: string): Promise<void> {
  try {
    const rows = await sql`SELECT id, documentos, datos FROM solicitudes WHERE id::text = ${solicitudId} LIMIT 1`;
    if (!rows || rows.length === 0) return;
    const rawDocs = rows[0].documentos;
    const docs = typeof rawDocs === 'string' ? JSON.parse(rawDocs) : (rawDocs || {});

    const sensitiveUrls = [
      docs.ine_frente,
      docs.ine_reverso,
      docs.selfie,
      docs.tarjeta_url,
      docs.licencia_url,
    ].filter((u: any) => u && typeof u === "string" && u.startsWith("http"));

    for (const url of sensitiveUrls) {
      await deleteSupabaseStorageFile(url);
    }

    // Conservar solo logo/foto de fachada si existe; marcar los datos sensibles como eliminados
    const logoConservado = docs.logo || docs.fachada || null;
    const updatedDocs = {
      ...(logoConservado ? { logo: logoConservado } : {}),
      ine_frente: '[ELIMINADO_POR_PRIVACIDAD]',
      ine_reverso: '[ELIMINADO_POR_PRIVACIDAD]',
      selfie: '[ELIMINADO_POR_PRIVACIDAD]',
      eliminado_en: new Date().toISOString(),
    };

    await sql`
      UPDATE solicitudes
      SET documentos = ${JSON.stringify(updatedDocs)}
      WHERE id = ${rows[0].id}
    `;
    console.log(`[Privacy] Documentos sensibles eliminados permanentemente para solicitud ${rows[0].id}`);
  } catch (err: any) {
    logError(err, "purgeSolicitudSensitiveDocs");
  }
}

/**
 * Lógica integral para aprobar un Restaurante
 */
export async function aprobarRestaurante(solicitudId: string): Promise<{ ok: boolean; nombre: string; error?: string }> {
  try {
    const solRows = await sql`
      SELECT * FROM solicitudes
      WHERE (id::text = ${solicitudId} OR usuario_id = ${solicitudId})
        AND tipo = 'negocio'
      ORDER BY creado_en DESC
      LIMIT 1
    `;
    if (solRows.length === 0) return { ok: false, nombre: "", error: "Solicitud no encontrada" };

    const sol = solRows[0];
    const realSolId = String(sol.id);
    const usuarioId = sol.usuario_id;
    const datos = typeof sol.datos === 'string' ? JSON.parse(sol.datos) : (sol.datos || {});
    const documentos = typeof sol.documentos === 'string' ? JSON.parse(sol.documentos) : (sol.documentos || {});

    const nombre = datos.nombre_negocio || datos.nombre || "Mi Restaurante";
    const categoria = datos.tipo_negocio || datos.categoria || "Restaurante";
    const tipo = (datos.tipo_negocio || datos.categoria || 'restaurante').toLowerCase().includes('tienda') ? 'tienda' : 'restaurante';
    const direccion = datos.direccion || "";
    const calle = datos.calle || "";
    const numeroExt = datos.numero_ext || "";
    const numeroInt = datos.numero_int || "";
    const colonia = datos.colonia || "";
    const codigoPostal = datos.codigo_postal || "";
    const referencias = datos.referencias || "";
    const lat = datos.lat != null ? Number(datos.lat) : null;
    const lng = datos.lng != null ? Number(datos.lng) : null;
    const telefono = datos.telefono || "";
    const logoUrl = (documentos.logo && !String(documentos.logo).startsWith("[")) ? documentos.logo : (documentos.foto || null);

    // 1. Crear o actualizar en viveres
    const existing = await sql`SELECT id FROM viveres WHERE owner_id = ${usuarioId} OR user_id = ${usuarioId} LIMIT 1`;
    let negocioId = existing[0]?.id;

    if (!negocioId) {
      const inserted = await sql`
        INSERT INTO viveres (
          owner_id, user_id, nombre, categoria, tipo, direccion,
          calle, numero_ext, numero_int, colonia, codigo_postal, referencias,
          latitud, lat, longitud, lng,
          telefono, logo_url, imagen_url, esta_abierto, status, aceptando_pedidos, bloqueado, suspendido
        ) VALUES (
          ${usuarioId}, ${usuarioId}, ${nombre}, ${categoria}, ${tipo}, ${direccion},
          ${calle}, ${numeroExt}, ${numeroInt}, ${colonia}, ${codigoPostal}, ${referencias},
          ${lat}, ${lat}, ${lng}, ${lng},
          ${telefono}, ${logoUrl}, ${logoUrl}, true, 'aprobado', true, false, false
        ) RETURNING id
      `;
      negocioId = inserted[0]?.id;
    } else {
      await sql`
        UPDATE viveres SET
          owner_id      = COALESCE(owner_id, ${usuarioId}),
          user_id       = COALESCE(user_id, ${usuarioId}),
          nombre        = ${nombre},
          categoria     = ${categoria},
          tipo          = ${tipo},
          direccion     = COALESCE(NULLIF(${direccion}, ''), direccion),
          calle         = COALESCE(NULLIF(${calle}, ''), calle),
          numero_ext    = COALESCE(NULLIF(${numeroExt}, ''), numero_ext),
          numero_int    = COALESCE(NULLIF(${numeroInt}, ''), numero_int),
          colonia       = COALESCE(NULLIF(${colonia}, ''), colonia),
          codigo_postal = COALESCE(NULLIF(${codigoPostal}, ''), codigo_postal),
          referencias   = COALESCE(NULLIF(${referencias}, ''), referencias),
          latitud       = COALESCE(${lat}, latitud),
          lat           = COALESCE(${lat}, lat),
          longitud      = COALESCE(${lng}, longitud),
          lng           = COALESCE(${lng}, lng),
          telefono      = COALESCE(NULLIF(${telefono}, ''), telefono),
          logo_url      = COALESCE(${logoUrl}, logo_url),
          imagen_url    = COALESCE(${logoUrl}, imagen_url),
          status        = 'aprobado',
          esta_abierto  = true,
          aceptando_pedidos = true,
          bloqueado     = false,
          suspendido    = false
        WHERE id = ${negocioId}
      `;
    }

    // 2. Rol usuario a 'negocio'
    await sql`UPDATE usuarios SET rol = 'negocio', bloqueado = false WHERE id = ${usuarioId}`.catch(() => {});

    // 3. Marcar solicitud como aprobada
    await sql`
      UPDATE solicitudes
      SET status = 'aprobado', razon_rechazo = NULL, actualizado_en = NOW()
      WHERE usuario_id = ${usuarioId} AND tipo = 'negocio'
    `;

    // 4. ELIMINACIÓN DE PRIVACIDAD: Borrar INE y Selfie inmediatamente de Supabase Storage
    await purgeSolicitudSensitiveDocs(realSolId);

    // 5. Notificación en tiempo real (WebSocket + Push)
    notificarCliente(usuarioId, "solicitud_update", { status: "aprobado", rol: "restaurante", negocioId });
    sendPushToUser(
      sql, usuarioId,
      `¡${nombre} fue aprobado! 🎉`,
      "Ya apareces en Ya Voy. Completa tu menú y empieza a recibir pedidos.",
      { tipo: "aprobacion", rol: "restaurante" }
    ).catch(() => {});

    return { ok: true, nombre };
  } catch (err: any) {
    logError(err, "aprobarRestaurante");
    return { ok: false, nombre: "", error: err.message };
  }
}

/**
 * Lógica integral para rechazar un Restaurante
 */
export async function rechazarRestaurante(solicitudId: string, razon?: string): Promise<{ ok: boolean; nombre: string; error?: string }> {
  try {
    const solRows = await sql`
      SELECT * FROM solicitudes
      WHERE (id::text = ${solicitudId} OR usuario_id = ${solicitudId})
        AND tipo = 'negocio'
      ORDER BY creado_en DESC
      LIMIT 1
    `;
    if (solRows.length === 0) return { ok: false, nombre: "", error: "Solicitud no encontrada" };

    const sol = solRows[0];
    const realSolId = String(sol.id);
    const usuarioId = sol.usuario_id;
    const datos = typeof sol.datos === 'string' ? JSON.parse(sol.datos) : (sol.datos || {});
    const nombre = datos.nombre_negocio || datos.nombre || "Restaurante";
    const motivoFinal = razon || "Documentación no legible o datos inconsistentes";

    // 1. Marcar solicitud como rechazada
    await sql`
      UPDATE solicitudes
      SET status = 'rechazado', razon_rechazo = ${motivoFinal}, actualizado_en = NOW()
      WHERE usuario_id = ${usuarioId} AND tipo = 'negocio'
    `;

    // 2. ELIMINACIÓN DE PRIVACIDAD: Borrar INE y Selfie de Supabase Storage
    await purgeSolicitudSensitiveDocs(realSolId);

    // 3. Notificación en tiempo real (WebSocket + Push)
    notificarCliente(usuarioId, "solicitud_update", { status: "rechazado", rol: "restaurante", razon: motivoFinal });
    sendPushToUser(
      sql, usuarioId,
      "Solicitud de restaurante rechazada",
      motivoFinal,
      { tipo: "rechazo", rol: "restaurante", razon: motivoFinal }
    ).catch(() => {});

    return { ok: true, nombre };
  } catch (err: any) {
    logError(err, "rechazarRestaurante");
    return { ok: false, nombre: "", error: err.message };
  }
}

/**
 * Lógica integral para aprobar un Repartidor
 */
export async function aprobarRepartidor(solicitudId: string): Promise<{ ok: boolean; nombre: string; error?: string }> {
  try {
    const solRows = await sql`
      SELECT * FROM solicitudes
      WHERE (id::text = ${solicitudId} OR usuario_id = ${solicitudId})
        AND tipo = 'repartidor'
      ORDER BY creado_en DESC
      LIMIT 1
    `;
    if (solRows.length === 0) return { ok: false, nombre: "", error: "Solicitud no encontrada" };

    const sol = solRows[0];
    const realSolId = String(sol.id);
    const usuarioId = sol.usuario_id;
    const datos = typeof sol.datos === 'string' ? JSON.parse(sol.datos) : (sol.datos || {});
    const nombre = datos.nombre || [datos.nombres, datos.primer_apellido, datos.segundo_apellido].filter(Boolean).join(" ") || "Repartidor";
    const vTipo = datos.vehiculo_tipo || "moto";
    const vModelo = datos.vehiculo_modelo || "";
    const vPlacas = datos.vehiculo_placas || "";

    // Garantizar que la columna usuario_id exista antes de insertar
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS usuario_id TEXT`.catch(() => {});
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS user_id TEXT`.catch(() => {});

    // 1. Crear o activar registro de repartidor con todos los campos sincronizados
    await sql`
      INSERT INTO repartidores (
        id, usuario_id, user_id, nombre, email, telefono,
        vehiculo_tipo, vehiculo, vehiculo_modelo, vehiculo_placas, placas, placa,
        disponible, activo, verificado, is_verified, bloqueado, razon_bloqueo
      )
      VALUES (
        ${usuarioId}, ${usuarioId}, ${usuarioId}, ${nombre}, ${datos.email || ""}, ${datos.telefono || ""},
        ${vTipo}, ${vTipo}, ${vModelo}, ${vPlacas}, ${vPlacas}, ${vPlacas},
        true, true, true, true, false, NULL
      )
      ON CONFLICT (id) DO UPDATE SET
        usuario_id = ${usuarioId},
        user_id = ${usuarioId},
        nombre = COALESCE(NULLIF(${nombre}, ''), repartidores.nombre),
        email = COALESCE(NULLIF(${datos.email || ""}, ''), repartidores.email),
        telefono = COALESCE(NULLIF(${datos.telefono || ""}, ''), repartidores.telefono),
        vehiculo_tipo = ${vTipo},
        vehiculo = ${vTipo},
        vehiculo_modelo = ${vModelo},
        vehiculo_placas = ${vPlacas},
        placas = ${vPlacas},
        placa = ${vPlacas},
        disponible = true,
        activo = true,
        verificado = true,
        is_verified = true,
        bloqueado = false,
        razon_bloqueo = NULL
    `;

    // 2. Rol usuario a 'repartidor'
    await sql`UPDATE usuarios SET rol = 'repartidor', bloqueado = false WHERE id = ${usuarioId}`.catch(() => {});

    // 3. Marcar todas las solicitudes de repartidor de este usuario como aprobadas
    await sql`
      UPDATE solicitudes
      SET status = 'aprobado', razon_rechazo = NULL, actualizado_en = NOW()
      WHERE usuario_id = ${usuarioId} AND tipo = 'repartidor'
    `;

    // 4. ELIMINACIÓN DE PRIVACIDAD: Borrar INE, Licencia y Selfie físicamente de Supabase Storage
    await purgeSolicitudSensitiveDocs(realSolId);

    // 5. Notificación en tiempo real (WebSocket + Push)
    notificarCliente(usuarioId, "solicitud_update", { status: "aprobado", rol: "repartidor" });
    sendPushToUser(
      sql, usuarioId,
      "¡Fuiste aprobado como repartidor! 🛵",
      "Ya puedes conectarte y empezar a recibir pedidos.",
      { tipo: "aprobacion", rol: "repartidor" }
    ).catch(() => {});

    return { ok: true, nombre };
  } catch (err: any) {
    logError(err, "aprobarRepartidor");
    return { ok: false, nombre: "", error: err.message };
  }
}

/**
 * Lógica integral para rechazar un Repartidor
 */
export async function rechazarRepartidor(solicitudId: string, razon?: string): Promise<{ ok: boolean; nombre: string; error?: string }> {
  try {
    const solRows = await sql`
      SELECT * FROM solicitudes
      WHERE (id::text = ${solicitudId} OR usuario_id = ${solicitudId})
        AND tipo = 'repartidor'
      ORDER BY creado_en DESC
      LIMIT 1
    `;
    if (solRows.length === 0) return { ok: false, nombre: "", error: "Solicitud no encontrada" };

    const sol = solRows[0];
    const realSolId = String(sol.id);
    const usuarioId = sol.usuario_id;
    const datos = typeof sol.datos === 'string' ? JSON.parse(sol.datos) : (sol.datos || {});
    const nombre = datos.nombre || [datos.nombres, datos.primer_apellido, datos.segundo_apellido].filter(Boolean).join(" ") || "Repartidor";
    const motivoFinal = razon || "Documentación no legible o datos inconsistentes";

    // 1. Marcar solicitud como rechazada
    await sql`
      UPDATE solicitudes
      SET status = 'rechazado', razon_rechazo = ${motivoFinal}, actualizado_en = NOW()
      WHERE usuario_id = ${usuarioId} AND tipo = 'repartidor'
    `;

    // 2. ELIMINACIÓN DE PRIVACIDAD: Borrar INE, Licencia y Selfie de Supabase Storage
    await purgeSolicitudSensitiveDocs(realSolId);

    // 3. Notificación en tiempo real (WebSocket + Push)
    notificarCliente(usuarioId, "solicitud_update", { status: "rechazado", rol: "repartidor", razon: motivoFinal });
    sendPushToUser(
      sql, usuarioId,
      "Solicitud de repartidor rechazada",
      motivoFinal,
      { tipo: "rechazo", rol: "repartidor", razon: motivoFinal }
    ).catch(() => {});

    return { ok: true, nombre };
  } catch (err: any) {
    logError(err, "rechazarRepartidor");
    return { ok: false, nombre: "", error: err.message };
  }
}

