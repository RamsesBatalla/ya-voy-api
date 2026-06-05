import { sql } from "./db"

export async function runMigrations() {
  // ── Extensiones ───────────────────────────────────────────────────────────
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`

  // ── Columnas existentes ───────────────────────────────────────────────────
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS payment_intent_id TEXT`
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tiempo_estimado_min INT`
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pago_fallido_en TIMESTAMPTZ`
  await sql`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS eliminado_en TIMESTAMPTZ`
  await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS propina NUMERIC DEFAULT 0`
  await sql`ALTER TABLE productos ADD COLUMN IF NOT EXISTS agotado BOOLEAN DEFAULT false`

  // ── Nuevas columnas — pickup, pedidos programados ─────────────────────────
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

  // ── Mensajes — columna tipo para chat restaurante ─────────────────────────
  await sql`ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS emisor_tipo TEXT DEFAULT 'repartidor'`

  // ── Índices de pedidos ────────────────────────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS idx_pedidos_status_creado   ON pedidos(status, creado_en DESC)`
  await sql`CREATE INDEX IF NOT EXISTS idx_pedidos_negocio_status  ON pedidos(negocio_id, status)`
  await sql`CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_status  ON pedidos(cliente_id, status)`
  await sql`CREATE INDEX IF NOT EXISTS idx_pedidos_payment_intent  ON pedidos(payment_intent_id) WHERE payment_intent_id IS NOT NULL`
  await sql`CREATE INDEX IF NOT EXISTS idx_pedidos_programado ON pedidos(status, programado_para) WHERE programado_para IS NOT NULL`

  // ── Índices de repartidores / negocios ───────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS idx_repartidores_status     ON repartidores(status)`
  await sql`CREATE INDEX IF NOT EXISTS idx_viveres_status_abierto  ON viveres(status, esta_abierto)`

  // ── Índices pg_trgm para búsqueda fuzzy ──────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS idx_viveres_nombre_trgm   ON viveres   USING gin(nombre gin_trgm_ops)`
  await sql`CREATE INDEX IF NOT EXISTS idx_productos_nombre_trgm ON productos USING gin(nombre gin_trgm_ops)`

  console.log("Migraciones completadas")
}
