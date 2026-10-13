import { sql, supabase } from "../db";
import { sendPushToUser } from "../firebase";
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
    const rows = await sql`SELECT documentos, datos FROM solicitudes WHERE id = ${solicitudId} LIMIT 1`;
    if (!rows || rows.length === 0) return;
    const docs = rows[0].documentos || {};

    const sensitiveUrls = [
      docs.ine_frente,
      docs.ine_reverso,
      docs.selfie,
      docs.tarjeta_url,
      docs.licencia_url,
    ].filter(Boolean);

    for (const url of sensitiveUrls) {
      await deleteSupabaseStorageFile(url);
    }

    // Conservar solo logo/foto de fachada si existe; marcar los datos sensibles como eliminados
    const logoConservado = docs.logo || docs.fachada || null;

    await sql`
      UPDATE solicitudes
      SET documentos = jsonb_build_object(
        'logo', ${logoConservado},
        'ine_frente', '[ELIMINADO_POR_PRIVACIDAD]',
        'ine_reverso', '[ELIMINADO_POR_PRIVACIDAD]',
        'selfie', '[ELIMINADO_POR_PRIVACIDAD]',
        'eliminado_en', NOW()
      )
      WHERE id = ${solicitudId}
    `;
    console.log(`[Privacy] Documentos sensibles eliminados permanentemente para solicitud ${solicitudId}`);
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
      SELECT * FROM solicitudes WHERE id = ${solicitudId} AND tipo = 'negocio' LIMIT 1
    `;
    if (solRows.length === 0) return { ok: false, nombre: "", error: "Solicitud no encontrada" };

    const sol = solRows[0];
    const usuarioId = sol.usuario_id;
    const datos = sol.datos || {};
    const documentos = sol.documentos || {};

    const nombre = datos.nombre_negocio || datos.nombre || "Mi Restaurante";
    const categoria = datos.tipo_negocio || datos.categoria || "Restaurante";
    const direccion = datos.direccion || "";
    const lat = datos.lat != null ? Number(datos.lat) : null;
    const lng = datos.lng != null ? Number(datos.lng) : null;
    const telefono = datos.telefono || "";
    const logoUrl = documentos.logo || documentos.foto || null;

    // 1. Crear o actualizar en viveres
    const existing = await sql`SELECT id FROM viveres WHERE owner_id = ${usuarioId} LIMIT 1`;
    let negocioId = existing[0]?.id;

    if (!negocioId) {
      const inserted = await sql`
        INSERT INTO viveres (
          owner_id, nombre, categoria, direccion, latitud, longitud,
          telefono, logo_url, esta_abierto, status
        ) VALUES (
          ${usuarioId}, ${nombre}, ${categoria}, ${direccion}, ${lat}, ${lng},
          ${telefono}, ${logoUrl}, true, 'aprobado'
        ) RETURNING id
      `;
      negocioId = inserted[0]?.id;
    } else {
      await sql`
        UPDATE viveres SET
          nombre = ${nombre},
          categoria = ${categoria},
          direccion = COALESCE(NULLIF(${direccion}, ''), direccion),
          latitud = COALESCE(${lat}, latitud),
          longitud = COALESCE(${lng}, longitud),
          telefono = COALESCE(NULLIF(${telefono}, ''), telefono),
          logo_url = COALESCE(${logoUrl}, logo_url),
          status = 'aprobado',
          esta_abierto = true
        WHERE id = ${negocioId}
      `;
    }

    // 2. Rol usuario a 'negocio'
    await sql`UPDATE usuarios SET rol = 'negocio' WHERE id = ${usuarioId}`;

    // 3. Marcar solicitud como aprobada
    await sql`
      UPDATE solicitudes
      SET status = 'aprobado', razon_rechazo = NULL
      WHERE id = ${solicitudId}
    `;

    // 4. ELIMINACIÓN DE PRIVACIDAD: Borrar INE y Selfie inmediatamente de Supabase Storage
    await purgeSolicitudSensitiveDocs(solicitudId);

    // 5. Push notification
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
      SELECT * FROM solicitudes WHERE id = ${solicitudId} AND tipo = 'negocio' LIMIT 1
    `;
    if (solRows.length === 0) return { ok: false, nombre: "", error: "Solicitud no encontrada" };

    const sol = solRows[0];
    const usuarioId = sol.usuario_id;
    const nombre = sol.datos?.nombre_negocio || "Restaurante";

    // 1. Marcar solicitud como rechazada
    await sql`
      UPDATE solicitudes
      SET status = 'rechazado', razon_rechazo = ${razon || "Documentación no legible o datos inconsistentes"}
      WHERE id = ${solicitudId}
    `;

    // 2. ELIMINACIÓN DE PRIVACIDAD: Borrar INE y Selfie de Supabase Storage
    await purgeSolicitudSensitiveDocs(solicitudId);

    // 3. Push notification
    sendPushToUser(
      sql, usuarioId,
      "Solicitud de restaurante rechazada",
      razon || "Tu solicitud no fue aprobada en este momento. Revisa la información y vuelve a intentar.",
      { tipo: "rechazo", rol: "restaurante" }
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
      SELECT * FROM solicitudes WHERE id = ${solicitudId} AND tipo = 'repartidor' LIMIT 1
    `;
    if (solRows.length === 0) return { ok: false, nombre: "", error: "Solicitud no encontrada" };

    const sol = solRows[0];
    const usuarioId = sol.usuario_id;
    const datos = sol.datos || {};
    const nombre = datos.nombre || "Repartidor";

    // 1. Crear o activar registro de repartidor
    await sql`
      INSERT INTO repartidores (id, usuario_id, nombre, email, telefono, vehiculo_tipo, vehiculo_modelo, vehiculo_placas, disponible, activo)
      VALUES (${usuarioId}, ${usuarioId}, ${nombre}, ${datos.email || ""}, ${datos.telefono || ""}, ${datos.vehiculo_tipo || "moto"}, ${datos.vehiculo_modelo || ""}, ${datos.vehiculo_placas || ""}, true, true)
      ON CONFLICT (id) DO UPDATE SET disponible = true, activo = true, vehiculo_tipo = ${datos.vehiculo_tipo || "moto"}
    `;

    // 2. Rol usuario a 'repartidor'
    await sql`UPDATE usuarios SET rol = 'repartidor' WHERE id = ${usuarioId}`;

    // 3. Marcar solicitud como aprobada
    await sql`
      UPDATE solicitudes
      SET status = 'aprobado', razon_rechazo = NULL
      WHERE id = ${solicitudId}
    `;

    // 4. ELIMINACIÓN DE PRIVACIDAD: Borrar INE, Licencia y Selfie físicamente de Supabase Storage
    await purgeSolicitudSensitiveDocs(solicitudId);

    // 5. Notificación push
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
      SELECT * FROM solicitudes WHERE id = ${solicitudId} AND tipo = 'repartidor' LIMIT 1
    `;
    if (solRows.length === 0) return { ok: false, nombre: "", error: "Solicitud no encontrada" };

    const sol = solRows[0];
    const usuarioId = sol.usuario_id;
    const nombre = sol.datos?.nombre || "Repartidor";

    // 1. Marcar solicitud como rechazada
    await sql`
      UPDATE solicitudes
      SET status = 'rechazado', razon_rechazo = ${razon || "Documentación no legible o datos inconsistentes"}
      WHERE id = ${solicitudId}
    `;

    // 2. ELIMINACIÓN DE PRIVACIDAD: Borrar INE, Licencia y Selfie de Supabase Storage
    await purgeSolicitudSensitiveDocs(solicitudId);

    // 3. Notificación push
    sendPushToUser(
      sql, usuarioId,
      "Solicitud de repartidor rechazada",
      razon || "Tu solicitud no fue aprobada. Revisa tus documentos y vuelve a intentarlo.",
      { tipo: "rechazo", rol: "repartidor" }
    ).catch(() => {});

    return { ok: true, nombre };
  } catch (err: any) {
    logError(err, "rechazarRepartidor");
    return { ok: false, nombre: "", error: err.message };
  }
}
