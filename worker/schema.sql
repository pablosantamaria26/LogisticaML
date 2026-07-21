-- Flota ML 2.0 — Esquema D1 (SQLite)
-- Una fila de `cargas` = un comprobante fiscal completo listo para ARCA.

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  nombre TEXT NOT NULL,
  pin_hash TEXT,                          -- NULL = el PIN se define en el primer ingreso
  rol TEXT NOT NULL DEFAULT 'chofer',     -- chofer | admin
  email TEXT DEFAULT '',
  vehiculo_id TEXT,
  intentos_fallidos INTEGER DEFAULT 0,
  bloqueado_hasta TEXT,
  creado TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL,
  creado TEXT DEFAULT (datetime('now')),
  expira TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehiculos (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  emoji TEXT DEFAULT '🚛',
  descripcion TEXT DEFAULT '',
  tanque_litros INTEGER DEFAULT 70,
  km_actual INTEGER DEFAULT 0,
  service_cada_km INTEGER DEFAULT 10000
);

CREATE TABLE IF NOT EXISTS cargas (
  id TEXT PRIMARY KEY,                    -- uuid generado por el cliente (idempotencia)
  vehiculo_id TEXT NOT NULL,
  usuario_id INTEGER,
  usuario_nombre TEXT,
  -- ── Datos fiscales del comprobante ──
  fecha TEXT NOT NULL,                    -- YYYY-MM-DD (fecha impresa en el ticket)
  hora TEXT,
  tipo_comprobante TEXT,                  -- ej: TIQUE FACTURA A
  codigo_comprobante TEXT,                -- ej: 081
  punto_venta TEXT,                       -- ej: 00011
  numero_comprobante TEXT,                -- ej: 00033244
  emisor_razon_social TEXT,
  emisor_cuit TEXT,
  emisor_domicilio TEXT,
  emisor_localidad TEXT,
  emisor_iibb TEXT,
  emisor_condicion_iva TEXT,
  receptor_nombre TEXT,
  receptor_cuit TEXT,
  producto TEXT,                          -- ej: INFINIA DIESEL / SUPER
  litros REAL,
  precio_unitario REAL,
  neto_gravado REAL,
  iva_alicuota REAL,
  iva REAL,
  otros_tributos REAL,                    -- ITC/IDC/ICL impuestos combustibles
  percepciones REAL,
  exento REAL,
  no_gravado REAL,
  total REAL,
  condicion_pago TEXT,
  -- ── Operativo ──
  km INTEGER,
  km_confianza INTEGER,
  confianza INTEGER,                      -- confianza OCR ticket 0-100
  validacion TEXT DEFAULT 'ok',           -- ok | revisar | migrado | legacy
  validacion_detalle TEXT,                -- JSON array de advertencias
  foto_ticket TEXT,                       -- key en storage (KV/R2)
  foto_tablero TEXT,
  foto_pendiente TEXT,                    -- 'ticket' | 'tablero' | NULL — admin pidió reintento sin duplicar la carga
  original_json TEXT,                     -- respuesta cruda de la IA (auditoría)
  corregido_por TEXT,
  corregido_en TEXT,
  creado TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cargas_fecha ON cargas(fecha);
CREATE INDEX IF NOT EXISTS idx_cargas_veh ON cargas(vehiculo_id, fecha);
CREATE INDEX IF NOT EXISTS idx_cargas_validacion ON cargas(validacion);

CREATE TABLE IF NOT EXISTS servicios (
  id TEXT PRIMARY KEY,
  vehiculo_id TEXT NOT NULL,
  usuario_id INTEGER,
  tipo TEXT,                              -- oil-change | tires | suspension | brakes | other
  fecha TEXT,
  km INTEGER,
  proximo_cada_km INTEGER DEFAULT 10000,
  taller TEXT,
  notas TEXT,
  creado TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  usuario_id INTEGER,
  username TEXT,
  vehiculo_id TEXT,
  subscription TEXT NOT NULL,             -- JSON completo de la suscripción
  creado TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alertas_enviadas (
  clave TEXT PRIMARY KEY,                 -- ej: maint:hiace:135000
  creado TEXT DEFAULT (datetime('now'))
);