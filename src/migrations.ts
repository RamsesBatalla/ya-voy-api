import { sql } from "./db";
import { logError } from "./logger";

/**
 * Ejecuta la creación e inicialización de todas las tablas necesarias en Supabase (PostgreSQL)
 * garantizando que ninguna tabla o columna falte ni viole restricciones NOT NULL en las 3 apps.
 */
export async function runMigrations() {
  try {
    console.log("Iniciando migraciones en la base de datos de Supabase...");

    // 1. Tabla de Usuarios
    await sql`
      CREATE TABLE IF NOT EXISTS usuarios (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        nombre TEXT,
        telefono TEXT,
        foto_url TEXT,
        rol TEXT DEFAULT 'cliente',
        bloqueado BOOLEAN DEFAULT false,
        razon_bloqueo TEXT,
        bloqueado_pendiente BOOLEAN DEFAULT false,
        bloqueado_en TIMESTAMPTZ,
        stripe_customer_id TEXT,
        wallet_balance NUMERIC DEFAULT 0,
        puntos INT DEFAULT 0,
        referral_code TEXT,
        creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefono TEXT`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS foto_url TEXT`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rol TEXT DEFAULT 'cliente'`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS razon_bloqueo TEXT`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_pendiente BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_en TIMESTAMPTZ`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC DEFAULT 0`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS puntos INT DEFAULT 0`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS referral_code TEXT`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS foto_perfil TEXT`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rating NUMERIC DEFAULT 0.0`;
    await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS eliminado_en TIMESTAMPTZ`;
    await sql`ALTER TABLE usuarios ALTER COLUMN email DROP NOT NULL`.catch(() => {});

    // 2. Tabla de Solicitudes (Restaurantes y Repartidores)
    await sql`
      CREATE TABLE IF NOT EXISTS solicitudes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id TEXT NOT NULL,
        tipo TEXT NOT NULL,
        status TEXT DEFAULT 'pendiente',
        datos JSONB DEFAULT '{}'::jsonb,
        documentos JSONB DEFAULT '{}'::jsonb,
        razon_rechazo TEXT,
        creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        actualizado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;
    await sql`ALTER TABLE solicitudes ADD COLUMN IF NOT EXISTS datos JSONB DEFAULT '{}'::jsonb`;
    await sql`ALTER TABLE solicitudes ADD COLUMN IF NOT EXISTS documentos JSONB DEFAULT '{}'::jsonb`;
    await sql`ALTER TABLE solicitudes ADD COLUMN IF NOT EXISTS razon_rechazo TEXT`;
    await sql`ALTER TABLE solicitudes ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()`;

    // 3. Tabla de Víveres / Restaurantes
    await sql`
      CREATE TABLE IF NOT EXISTS viveres (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id TEXT NOT NULL,
        user_id TEXT,
        nombre TEXT NOT NULL,
        descripcion TEXT,
        categoria TEXT DEFAULT 'Restaurante',
        tipo TEXT DEFAULT 'Restaurante',
        direccion TEXT,
        calle TEXT,
        numero_ext TEXT,
        numero_int TEXT,
        colonia TEXT,
        codigo_postal TEXT,
        referencias TEXT,
        latitud DOUBLE PRECISION,
        longitud DOUBLE PRECISION,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        telefono TEXT,
        imagen_url TEXT,
        logo_url TEXT,
        banner_url TEXT,
        esta_abierto BOOLEAN DEFAULT true,
        aceptando_pedidos BOOLEAN DEFAULT true,
        cierre_manual_fecha TEXT,
        apertura_manual_fecha TEXT,
        status TEXT DEFAULT 'aprobado',
        calificacion NUMERIC DEFAULT 0.0,
        rating NUMERIC DEFAULT 0.0,
        total_resenas INTEGER DEFAULT 0,
        tiempo_preparacion TEXT DEFAULT '20-30 min',
        costo_envio_base NUMERIC DEFAULT 25,
        horarios JSONB DEFAULT '{}'::jsonb,
        stripe_account_id TEXT,
        clabe_bancaria TEXT,
        banco_nombre TEXT,
        titular_cuenta TEXT,
        bloqueado BOOLEAN DEFAULT false,
        razon_bloqueo TEXT,
        incidentes_count INT DEFAULT 0,
        suspendido BOOLEAN DEFAULT false,
        creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;
    await sql`ALTER TABLE viveres ALTER COLUMN calificacion SET DEFAULT 0.0`.catch(() => {});
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS user_id TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'Restaurante'`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS latitud DOUBLE PRECISION`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS longitud DOUBLE PRECISION`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS calle TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS numero_ext TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS numero_int TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS colonia TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS codigo_postal TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS referencias TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS imagen_url TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS logo_url TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS banner_url TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS aceptando_pedidos BOOLEAN DEFAULT true`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS cierre_manual_fecha TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS apertura_manual_fecha TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'aprobado'`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS rating NUMERIC DEFAULT 0.0`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS horarios JSONB DEFAULT '{}'::jsonb`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS stripe_account_id TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS clabe_bancaria TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS banco_nombre TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS titular_cuenta TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS bloqueado BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS razon_bloqueo TEXT`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS incidentes_count INT DEFAULT 0`;
    await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS suspendido BOOLEAN DEFAULT false`;
    // Sincronizar lat/lng con latitud/longitud si alguno está vacío
    await sql`UPDATE viveres SET user_id = owner_id WHERE user_id IS NULL AND owner_id IS NOT NULL`.catch(() => {});
    await sql`UPDATE viveres SET lat = latitud WHERE lat IS NULL AND latitud IS NOT NULL`.catch(() => {});
    await sql`UPDATE viveres SET lng = longitud WHERE lng IS NULL AND longitud IS NOT NULL`.catch(() => {});
    await sql`UPDATE viveres SET latitud = lat WHERE latitud IS NULL AND lat IS NOT NULL`.catch(() => {});
    await sql`UPDATE viveres SET longitud = lng WHERE longitud IS NULL AND lng IS NOT NULL`.catch(() => {});
    await sql`UPDATE viveres SET imagen_url = logo_url WHERE imagen_url IS NULL AND logo_url IS NOT NULL`.catch(() => {});
    await sql`UPDATE viveres SET logo_url = imagen_url WHERE logo_url IS NULL AND imagen_url IS NOT NULL`.catch(() => {});
    await sql`UPDATE viveres SET calificacion = 0.0 WHERE calificacion = 5.0 AND COALESCE(total_resenas, 0) = 0`.catch(() => {});
    await sql`UPDATE viveres SET rating = 0.0 WHERE rating = 5.0 AND COALESCE(total_resenas, 0) = 0`.catch(() => {});

    // 4. Tabla de Repartidores
    await sql`
      CREATE TABLE IF NOT EXISTS repartidores (
        id TEXT PRIMARY KEY,
        usuario_id TEXT,
        user_id TEXT,
        nombre TEXT NOT NULL DEFAULT 'Repartidor',
        email TEXT,
        telefono TEXT,
        foto_url TEXT,
        vehiculo_tipo TEXT DEFAULT 'moto',
        vehiculo TEXT DEFAULT 'moto',
        vehiculo_modelo TEXT,
        vehiculo_placas TEXT,
        placas TEXT,
        placa TEXT,
        status TEXT DEFAULT 'offline',
        disponible BOOLEAN DEFAULT false,
        en_linea BOOLEAN DEFAULT false,
        activo BOOLEAN DEFAULT true,
        verificado BOOLEAN DEFAULT true,
        latitud DOUBLE PRECISION,
        longitud DOUBLE PRECISION,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        lat_actual DOUBLE PRECISION,
        lng_actual DOUBLE PRECISION,
        calificacion NUMERIC DEFAULT 0.0,
        rating NUMERIC DEFAULT 0.0,
        total_entregas INTEGER DEFAULT 0,
        entregas_count INTEGER DEFAULT 0,
        deuda_efectivo NUMERIC DEFAULT 0,
        stripe_account_id TEXT,
        clabe_bancaria TEXT,
        banco_nombre TEXT,
        titular_cuenta TEXT,
        bloqueado BOOLEAN DEFAULT false,
        razon_bloqueo TEXT,
        creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS usuario_id TEXT`;
    await sql`ALTER TABLE repartidores ALTER COLUMN usuario_id DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS calificacion NUMERIC DEFAULT 0.0`;
    await sql`ALTER TABLE repartidores ALTER COLUMN calificacion SET DEFAULT 0.0`.catch(() => {});
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS total_entregas INTEGER DEFAULT 0`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS user_id TEXT`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS email TEXT`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS vehiculo TEXT DEFAULT 'moto'`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS vehiculo_modelo TEXT`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS vehiculo_placas TEXT`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS placas TEXT`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS placa TEXT`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'offline'`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS disponible BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS en_linea BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT true`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS verificado BOOLEAN DEFAULT true`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT true`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS lat_actual DOUBLE PRECISION`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS lng_actual DOUBLE PRECISION`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS rating NUMERIC DEFAULT 0.0`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS entregas_count INTEGER DEFAULT 0`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS deuda_efectivo NUMERIC DEFAULT 0`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS stripe_account_id TEXT`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS clabe_bancaria TEXT`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS banco_nombre TEXT`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS titular_cuenta TEXT`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS bloqueado BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS razon_bloqueo TEXT`;
    await sql`UPDATE repartidores SET usuario_id = COALESCE(user_id, id) WHERE usuario_id IS NULL`.catch(() => {});
    await sql`UPDATE repartidores SET user_id = COALESCE(usuario_id, id) WHERE user_id IS NULL`.catch(() => {});
    await sql`UPDATE repartidores SET vehiculo = vehiculo_tipo WHERE vehiculo IS NULL AND vehiculo_tipo IS NOT NULL`.catch(() => {});
    await sql`UPDATE repartidores SET placa = COALESCE(vehiculo_placas, placas) WHERE placa IS NULL`.catch(() => {});
    await sql`UPDATE repartidores SET status = 'online' WHERE en_linea = true AND (status IS NULL OR status = 'offline')`.catch(() => {});
    await sql`UPDATE repartidores SET calificacion = 0.0 WHERE calificacion = 5.0 AND COALESCE(total_entregas, 0) = 0`.catch(() => {});
    await sql`UPDATE repartidores SET rating = 0.0 WHERE rating = 5.0 AND COALESCE(total_entregas, 0) = 0`.catch(() => {});

    // 5. Tabla de Productos
    await sql`
      CREATE TABLE IF NOT EXISTS productos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        negocio_id UUID REFERENCES viveres(id) ON DELETE CASCADE,
        nombre TEXT NOT NULL,
        descripcion TEXT,
        precio NUMERIC NOT NULL DEFAULT 0,
        imagen_url TEXT,
        categoria TEXT DEFAULT 'General',
        disponible BOOLEAN DEFAULT true,
        agotado BOOLEAN DEFAULT false,
        destacado BOOLEAN DEFAULT false,
        opciones JSONB DEFAULT '[]'::jsonb,
        creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;
    await sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS agotado BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS destacado BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS opciones JSONB DEFAULT '[]'::jsonb`;
    await sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS disponible BOOLEAN DEFAULT true`;

    // 6. Tabla de Pedidos (Incluyendo TODAS las columnas usadas en usuario, restaurante y repartidor)
    await sql`
      CREATE TABLE IF NOT EXISTS pedidos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cliente_id TEXT NOT NULL,
        negocio_id UUID REFERENCES viveres(id) ON DELETE SET NULL,
        repartidor_id TEXT,
        status TEXT DEFAULT 'nuevo',
        total NUMERIC DEFAULT 0,
        subtotal NUMERIC DEFAULT 0,
        costo_envio NUMERIC DEFAULT 25,
        propina NUMERIC DEFAULT 0,
        descuento NUMERIC DEFAULT 0,
        cupon_codigo TEXT,
        monto_total NUMERIC DEFAULT 0,
        metodo_pago TEXT DEFAULT 'efectivo',
        payment_intent_id TEXT,
        tipo_entrega TEXT DEFAULT 'inmediato',
        programado_para TIMESTAMPTZ,
        notas TEXT DEFAULT '',
        direccion_entrega TEXT,
        lat_entrega DOUBLE PRECISION,
        lng_entrega DOUBLE PRECISION,
        latitud_entrega DOUBLE PRECISION,
        longitud_entrega DOUBLE PRECISION,
        items JSONB DEFAULT '[]'::jsonb,
        codigo_entrega TEXT,
        codigo_restaurante TEXT,
        palabras_verificacion JSONB,
        verificado_restaurante BOOLEAN DEFAULT false,
        recolectado_en TIMESTAMPTZ,
        asignado_en TIMESTAMPTZ,
        compensar_restaurante BOOLEAN DEFAULT false,
        tiempo_estimado TEXT DEFAULT '30-45 min',
        tiempo_estimado_min INT,
        distancia_km NUMERIC,
        foto_entrega_url TEXT,
        foto_entrega TEXT,
        foto_entrega_expira TIMESTAMPTZ,
        esperando_desde TIMESTAMPTZ,
        entregado_en TIMESTAMPTZ,
        cancelado_en TIMESTAMPTZ,
        razon_cancelacion TEXT,
        rating_negocio NUMERIC,
        rating_restaurante NUMERIC,
        rating_repartidor NUMERIC,
        rating_cliente NUMERIC,
        comentario_rating TEXT,
        aspectos_negocio TEXT[],
        aspectos_restaurante JSONB DEFAULT '[]'::jsonb,
        aspectos_repartidor JSONB DEFAULT '[]'::jsonb,
        aspectos_cliente JSONB DEFAULT '[]'::jsonb,
        creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        actualizado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;
    // Asegurar que monto_total y subtotal NO tengan restricción NOT NULL sin valor por defecto
    await sql`ALTER TABLE pedidos ALTER COLUMN monto_total DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE pedidos ALTER COLUMN monto_total SET DEFAULT 0`.catch(() => {});
    await sql`ALTER TABLE pedidos ALTER COLUMN subtotal DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE pedidos ALTER COLUMN subtotal SET DEFAULT 0`.catch(() => {});
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS total NUMERIC DEFAULT 0`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS subtotal NUMERIC DEFAULT 0`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS monto_total NUMERIC DEFAULT 0`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS costo_envio NUMERIC DEFAULT 25`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS propina NUMERIC DEFAULT 0`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS descuento NUMERIC DEFAULT 0`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cupon_codigo TEXT`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS metodo_pago TEXT DEFAULT 'efectivo'`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS payment_intent_id TEXT`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tipo_entrega TEXT DEFAULT 'inmediato'`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS programado_para TIMESTAMPTZ`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS notas TEXT DEFAULT ''`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS direccion_entrega TEXT`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS lat_entrega DOUBLE PRECISION`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS lng_entrega DOUBLE PRECISION`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS latitud_entrega DOUBLE PRECISION`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS longitud_entrega DOUBLE PRECISION`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS codigo_entrega TEXT`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS codigo_restaurante TEXT`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS palabras_verificacion JSONB`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS verificado_restaurante BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS recolectado_en TIMESTAMPTZ`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS asignado_en TIMESTAMPTZ`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS compensar_restaurante BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tiempo_estimado TEXT DEFAULT '30-45 min'`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tiempo_estimado_min INT`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS distancia_km NUMERIC`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS foto_entrega_url TEXT`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS foto_entrega TEXT`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS foto_entrega_expira TIMESTAMPTZ`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS esperando_desde TIMESTAMPTZ`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entregado_en TIMESTAMPTZ`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelado_en TIMESTAMPTZ`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS razon_cancelacion TEXT`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS rating_negocio NUMERIC`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS rating_restaurante NUMERIC`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS rating_repartidor NUMERIC`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS rating_cliente NUMERIC`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comentario_rating TEXT`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS aspectos_negocio TEXT[]`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS aspectos_restaurante JSONB DEFAULT '[]'::jsonb`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS aspectos_repartidor JSONB DEFAULT '[]'::jsonb`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS aspectos_cliente JSONB DEFAULT '[]'::jsonb`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS intentos_codigo INT DEFAULT 0`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pago_confirmado BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS wallet_monto NUMERIC DEFAULT 0`;
    await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()`;
    await sql`UPDATE pedidos SET total = monto_total WHERE (total IS NULL OR total = 0) AND monto_total IS NOT NULL AND monto_total > 0`.catch(() => {});
    await sql`UPDATE pedidos SET monto_total = total WHERE (monto_total IS NULL OR monto_total = 0) AND total IS NOT NULL AND total > 0`.catch(() => {});

    // 7. Tabla de Pedidos Rechazados por Repartidor (para cuando un repartidor rechaza tomar un pedido detectado)
    await sql`
      CREATE TABLE IF NOT EXISTS pedidos_rechazados (
        pedido_id TEXT NOT NULL,
        repartidor_id TEXT NOT NULL,
        creado_en TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (pedido_id, repartidor_id)
      );
    `;

    // 8. Tabla de Direcciones
    await sql`
      CREATE TABLE IF NOT EXISTS direcciones (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        usuario_id TEXT NOT NULL,
        nombre TEXT DEFAULT 'Casa',
        label TEXT DEFAULT 'Casa',
        icono TEXT DEFAULT '🏠',
        direccion TEXT NOT NULL,
        referencias TEXT,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        latitud DOUBLE PRECISION,
        longitud DOUBLE PRECISION,
        es_principal BOOLEAN DEFAULT false,
        principal BOOLEAN DEFAULT false,
        creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;
    await sql`ALTER TABLE direcciones ADD COLUMN IF NOT EXISTS label TEXT DEFAULT 'Casa'`;
    await sql`ALTER TABLE direcciones ADD COLUMN IF NOT EXISTS icono TEXT DEFAULT '🏠'`;
    await sql`ALTER TABLE direcciones ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`;
    await sql`ALTER TABLE direcciones ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`;
    await sql`ALTER TABLE direcciones ADD COLUMN IF NOT EXISTS principal BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE direcciones ADD COLUMN IF NOT EXISTS es_principal BOOLEAN DEFAULT false`;

    // 9. Tabla de Favoritos
    await sql`
      CREATE TABLE IF NOT EXISTS favoritos (
        id SERIAL PRIMARY KEY,
        usuario_id TEXT NOT NULL,
        negocio_id UUID REFERENCES viveres(id) ON DELETE CASCADE,
        creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE (usuario_id, negocio_id)
      );
    `;

    // 10. Tabla de Mensajes (compatible con ambos esquemas)
    await sql`
      CREATE TABLE IF NOT EXISTS mensajes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pedido_id TEXT NOT NULL,
        emisor_id TEXT,
        rol_emisor TEXT,
        mensaje TEXT,
        remitente_id TEXT,
        remitente_rol TEXT,
        contenido TEXT,
        leido BOOLEAN DEFAULT false,
        creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;
    await sql`ALTER TABLE mensajes ALTER COLUMN remitente_id DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE mensajes ALTER COLUMN remitente_rol DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE mensajes ALTER COLUMN contenido DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS emisor_id TEXT`;
    await sql`ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS rol_emisor TEXT`;
    await sql`ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS mensaje TEXT`;

    // 11. Tabla de Device Tokens (Push Notifications)
    await sql`
      CREATE TABLE IF NOT EXISTS device_tokens (
        user_id TEXT NOT NULL,
        token TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        PRIMARY KEY (user_id, token)
      );
    `;
    await sql`ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()`;

    // 12. Tabla de Configuración de la App
    await sql`
      CREATE TABLE IF NOT EXISTS app_config (
        clave TEXT PRIMARY KEY,
        valor TEXT NOT NULL,
        actualizado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;
    // Insertar configuraciones base si no existen
    await sql`
      INSERT INTO app_config (clave, valor) VALUES
        ('envio_minimo', '25'),
        ('envio_por_km', '8'),
        ('comision_pct', '18'),
        ('fondo_pct', '20'),
        ('retiro_minimo', '50'),
        ('radio_max_usuario_km', '10'),
        ('radio_max_repartidor_km', '10'),
        ('mantenimiento', 'false')
      ON CONFLICT (clave) DO NOTHING
    `.catch(() => {});
    await sql`UPDATE app_config SET valor = '10' WHERE clave = 'radio_max_usuario_km' AND valor = '25'`.catch(() => {});
    await sql`UPDATE app_config SET valor = '10' WHERE clave = 'radio_max_repartidor_km' AND valor = '15'`.catch(() => {});

    // 13. Tablas de Cupones, Wallet, Puntos, Referidos y Notificaciones
    await sql`
      CREATE TABLE IF NOT EXISTS cupones (
        id SERIAL PRIMARY KEY,
        codigo TEXT UNIQUE NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'monto',
        valor NUMERIC NOT NULL DEFAULT 0,
        monto_minimo NUMERIC DEFAULT 0,
        usos_max INT,
        usos_actuales INT DEFAULT 0,
        activo BOOLEAN DEFAULT true,
        expira_en TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS wallet_movimientos (
        id SERIAL PRIMARY KEY,
        usuario_id TEXT NOT NULL,
        tipo TEXT NOT NULL,
        monto NUMERIC NOT NULL,
        concepto TEXT,
        pedido_id TEXT,
        creado_en TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS puntos_movimientos (
        id SERIAL PRIMARY KEY,
        usuario_id TEXT NOT NULL,
        puntos INT NOT NULL,
        concepto TEXT,
        creado_en TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS referidos (
        id SERIAL PRIMARY KEY,
        referidor_id TEXT NOT NULL,
        referido_id TEXT NOT NULL,
        creado_en TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS notificaciones (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        titulo TEXT NOT NULL,
        cuerpo TEXT NOT NULL,
        tipo TEXT DEFAULT 'general',
        datos JSONB,
        leida BOOLEAN DEFAULT false,
        creado_en TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS retiros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tipo_actor TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_nombre TEXT,
        monto NUMERIC NOT NULL,
        status TEXT DEFAULT 'pendiente',
        fecha_solicitud TIMESTAMPTZ DEFAULT NOW(),
        fecha_pago TIMESTAMPTZ,
        nota_admin TEXT,
        creado_en TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS fondo_recuperacion (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tipo TEXT NOT NULL,
        monto NUMERIC NOT NULL,
        descripcion TEXT,
        pedido_id TEXT,
        aprobado_por TEXT DEFAULT 'admin',
        creado_en TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS bloqueos_historial (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tipo_usuario TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        razon TEXT,
        bloqueado_por TEXT DEFAULT 'admin',
        fecha TIMESTAMPTZ DEFAULT NOW(),
        desbloqueado_en TIMESTAMPTZ,
        resuelto BOOLEAN DEFAULT false,
        nota_desbloqueo TEXT
      );
    `;

    console.log("Migraciones en Supabase completadas exitosamente.");
  } catch (err: any) {
    logError(err, "runMigrations");
    console.error("Error al ejecutar migraciones:", err);
  }
}
