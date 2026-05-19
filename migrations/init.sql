-- CERTIMOTORS Schema for Supabase PostgreSQL
-- Ejecuta esto en Supabase → SQL Editor para crear las tablas

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Tabla: Clientes
CREATE TABLE IF NOT EXISTS clientes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  numero_telefono VARCHAR(20) UNIQUE NOT NULL,
  nombre VARCHAR(255),
  tipo VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Tabla: Órdenes
CREATE TABLE IF NOT EXISTS ordenes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  placa VARCHAR(10) UNIQUE NOT NULL,
  cliente_id UUID NOT NULL,
  tipo_auto VARCHAR(100),
  status VARCHAR(50) DEFAULT 'INICIADA',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
);

-- Tabla: Conversaciones WhatsApp
CREATE TABLE IF NOT EXISTS conversaciones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  placa VARCHAR(10) NOT NULL,
  cliente_id UUID NOT NULL,
  tipo_usuario VARCHAR(50),
  mensaje_entrada TEXT,
  respuesta_ia TEXT,
  tokens_usados INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (placa) REFERENCES ordenes(placa) ON DELETE CASCADE,
  FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
);

-- Tabla: Revisiones Mecánicas
CREATE TABLE IF NOT EXISTS revisiones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  placa VARCHAR(10) NOT NULL,
  mecanico_id VARCHAR(50),
  punto_actual INTEGER,
  respuesta TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (placa) REFERENCES ordenes(placa) ON DELETE CASCADE
);

-- Tabla: Notificaciones
CREATE TABLE IF NOT EXISTS notificaciones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  placa VARCHAR(10) NOT NULL,
  tipo VARCHAR(100),
  mensaje TEXT,
  enviado BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (placa) REFERENCES ordenes(placa) ON DELETE CASCADE
);

-- Índices para mejor performance
CREATE INDEX idx_ordenes_placa ON ordenes(placa);
CREATE INDEX idx_ordenes_cliente ON ordenes(cliente_id);
CREATE INDEX idx_conversaciones_placa ON conversaciones(placa);
CREATE INDEX idx_revisiones_placa ON revisiones(placa);
CREATE INDEX idx_notificaciones_placa ON notificaciones(placa);
CREATE INDEX idx_clientes_telefono ON clientes(numero_telefono);

-- Row Level Security (opcional, para seguridad)
ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ordenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversaciones ENABLE ROW LEVEL SECURITY;

-- Política simple: permite lectura/escritura sin restricciones (desarrollo)
CREATE POLICY "allow_all" ON clientes USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON ordenes USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON conversaciones USING (true) WITH CHECK (true);

-- Vistas útiles para reportes
CREATE VIEW orden_completa AS
SELECT 
  o.id,
  o.placa,
  o.cliente_id,
  c.numero_telefono,
  c.nombre,
  o.tipo_auto,
  o.status,
  (SELECT COUNT(*) FROM revisiones r WHERE r.placa = o.placa) as puntos_completados,
  (SELECT COUNT(*) FROM conversaciones conv WHERE conv.placa = o.placa) as total_conversaciones,
  o.created_at,
  o.updated_at
FROM ordenes o
LEFT JOIN clientes c ON o.cliente_id = c.id;

-- Vista: Estadísticas diarias
CREATE VIEW estadisticas_diarias AS
SELECT 
  DATE(o.created_at) as fecha,
  COUNT(DISTINCT o.id) as total_ordenes,
  COUNT(DISTINCT o.cliente_id) as total_clientes,
  COUNT(DISTINCT r.id) as total_puntos_inspeccionados
FROM ordenes o
LEFT JOIN revisiones r ON o.placa = r.placa
GROUP BY DATE(o.created_at)
ORDER BY fecha DESC;
