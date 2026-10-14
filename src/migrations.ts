import { sql } from "./db"

export async function runMigrations() {
  // ── Extensiones ───────────────────────────────────────────────────────────
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`

  // ── 1. Usuarios ───────────────────────────────────────────────────────────
  await sql`CREATE TABLE IF NOT EXISTS usuarios (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    email TEXT,
    telefono TEXT,
    foto_url TEXT,
    rol TEXT DEFAULT 'cliente',
    wallet_balance NUMERIC DEFAULT 0,
    puntos INT DEFAULT 0,
    referral_code TEXT,
    eliminado_en TIMESTAMPTZ,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`

  // ── 2. Viveres / Restaurantes ──────────────────────────────────────────────
  await sql`CREATE TABLE IF NOT EXISTS viveres (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    owner_id TEXT,
    nombre TEXT NOT NULL,
    categoria TEXT DEFAULT 'Restaurante',
    logo_url TEXT,
    banner_url TEXT,
    direccion TEXT,
    latitud NUMERIC,
    longitud NUMERIC,
    telefono TEXT,
    esta_abierto BOOLEAN DEFAULT true,
    status TEXT DEFAULT 'activo',
    advertencia_calidad BOOLEAN DEFAULT false,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS owner_id TEXT`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS categoria TEXT`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS logo_url TEXT`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS banner_url TEXT`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS latitud NUMERIC`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS longitud NUMERIC`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS telefono TEXT`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS tipo TEXT`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS imagen_url TEXT`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS aceptando_pedidos BOOLEAN DEFAULT true`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS horarios JSONB`
  await sql`ALTER TABLE viveres ADD COLUMN IF NOT EXISTS horario JSONB`
  await sql`ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check`
  await sql`CREATE INDEX IF NOT EXISTS idx_viveres_owner_id ON viveres(owner_id)`

  // ── 2.1 Solicitudes de Afiliación (Restaurantes y Repartidores) ────────────
  await sql`CREATE TABLE IF NOT EXISTS solicitudes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id TEXT NOT NULL,
    tipo TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendiente',
    datos JSONB,
    documentos JSONB,
    razon_rechazo TEXT,
    creado_en TIMESTAMPTZ DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ DEFAULT NOW()
  )`
  await sql`CREATE INDEX IF NOT EXISTS idx_solicitudes_usuario ON solicitudes(usuario_id, creado_en DESC)`
  await sql`CREATE INDEX IF NOT EXISTS idx_solicitudes_status ON solicitudes(status, tipo)`

  // ── 2.2 Tokens de Dispositivos (Push Notifications) ───────────────────────
  await sql`CREATE TABLE IF NOT EXISTS device_tokens (
    user_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`
  await sql`CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id)`

  // ── 3. Productos ───────────────────────────────────────────────────────────
  await sql`CREATE TABLE IF NOT EXISTS productos (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    negocio_id TEXT NOT NULL,
    nombre TEXT NOT NULL,
    descripcion TEXT,
    precio NUMERIC NOT NULL,
    imagen_url TEXT,
    categoria TEXT DEFAULT 'General',
    disponible BOOLEAN DEFAULT true,
    agotado BOOLEAN DEFAULT false,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`

  // ── 4. Repartidores (con Verificación Efímera) ─────────────────────────────
  await sql`CREATE TABLE IF NOT EXISTS repartidores (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    email TEXT,
    telefono TEXT,
    foto_url TEXT,
    vehiculo_tipo TEXT DEFAULT 'moto',
    vehiculo_placas TEXT,
    is_verified BOOLEAN DEFAULT false,
    status TEXT DEFAULT 'pendiente',
    motivo_rechazo TEXT,
    latitud NUMERIC,
    longitud NUMERIC,
    en_linea BOOLEAN DEFAULT false,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`

  // ── 5. Pedidos ─────────────────────────────────────────────────────────────
  await sql`CREATE TABLE IF NOT EXISTS pedidos (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    cliente_id TEXT NOT NULL,
    negocio_id TEXT NOT NULL,
    repartidor_id TEXT,
    monto_total NUMERIC NOT NULL,
    subtotal NUMERIC NOT NULL,
    costo_envio NUMERIC DEFAULT 0,
    propina NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'pendiente',
    tipo_entrega TEXT DEFAULT 'domicilio',
    direccion_entrega TEXT,
    latitud_entrega NUMERIC,
    longitud_entrega NUMERIC,
    items JSONB,
    payment_intent_id TEXT,
    tiempo_estimado_min INT,
    programado_para TEXT,
    pago_fallido_en TIMESTAMPTZ,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`

  // ── 6. Mensajes (Chat) ─────────────────────────────────────────────────────
  await sql`CREATE TABLE IF NOT EXISTS mensajes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id TEXT NOT NULL,
    emisor_id TEXT NOT NULL,
    receptor_id TEXT NOT NULL,
    emisor_tipo TEXT DEFAULT 'repartidor',
    texto TEXT NOT NULL,
    leido BOOLEAN DEFAULT false,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`

  // ── Columnas adicionales ──────────────────────────────────────────────────
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS payment_intent_id TEXT`
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tiempo_estimado_min INT`
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pago_fallido_en TIMESTAMPTZ`
  await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS eliminado_en TIMESTAMPTZ`
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS propina NUMERIC DEFAULT 0`
  await sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS agotado BOOLEAN DEFAULT false`
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tipo_entrega TEXT DEFAULT 'domicilio'`
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS programado_para TEXT`

  // ── Wallet ────────────────────────────────────────────────────────────────
  await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC DEFAULT 0`
  await sql`CREATE TABLE IF NOT EXISTS wallet_movimientos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('credito','debito')),
    monto NUMERIC NOT NULL,
    concepto TEXT NOT NULL,
    pedido_id TEXT,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`
  await sql`CREATE INDEX IF NOT EXISTS idx_wallet_usuario ON wallet_movimientos(usuario_id, creado_en DESC)`

  // ── Puntos ────────────────────────────────────────────────────────────────
  await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS puntos INT DEFAULT 0`
  await sql`CREATE TABLE IF NOT EXISTS puntos_movimientos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id TEXT NOT NULL,
    puntos INT NOT NULL,
    concepto TEXT NOT NULL,
    pedido_id TEXT,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`
  await sql`CREATE INDEX IF NOT EXISTS idx_puntos_usuario ON puntos_movimientos(usuario_id, creado_en DESC)`

  // ── Referidos ─────────────────────────────────────────────────────────────
  await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS referral_code TEXT`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_referral_code ON usuarios(referral_code) WHERE referral_code IS NOT NULL`
  await sql`CREATE TABLE IF NOT EXISTS referidos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referidor_id TEXT NOT NULL,
    referido_id TEXT NOT NULL UNIQUE,
    recompensa_aplicada BOOLEAN DEFAULT false,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`

  // ── Notificaciones in-app ─────────────────────────────────────────────────
  await sql`CREATE TABLE IF NOT EXISTS notificaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    titulo TEXT NOT NULL,
    cuerpo TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'general',
    leida BOOLEAN DEFAULT false,
    datos JSONB,
    creado_en TIMESTAMPTZ DEFAULT NOW()
  )`
  await sql`CREATE INDEX IF NOT EXISTS idx_notif_user ON notificaciones(user_id, creado_en DESC)`

  // ── Índices ───────────────────────────────────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS idx_pedidos_status_creado   ON pedidos(status, creado_en DESC)`
  await sql`CREATE INDEX IF NOT EXISTS idx_pedidos_negocio_status  ON pedidos(negocio_id, status)`
  await sql`CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_status  ON pedidos(cliente_id, status)`
  await sql`CREATE INDEX IF NOT EXISTS idx_pedidos_payment_intent  ON pedidos(payment_intent_id) WHERE payment_intent_id IS NOT NULL`
  await sql`CREATE INDEX IF NOT EXISTS idx_repartidores_status     ON repartidores(status)`
  await sql`CREATE INDEX IF NOT EXISTS idx_viveres_status_abierto  ON viveres(status, esta_abierto)`

  await sql`CREATE INDEX IF NOT EXISTS idx_viveres_nombre_trgm   ON viveres   USING gin(nombre gin_trgm_ops)`
  await sql`CREATE INDEX IF NOT EXISTS idx_productos_nombre_trgm ON productos USING gin(nombre gin_trgm_ops)`

  console.log("Migraciones en Supabase completadas exitosamente")
}
