-- Tabla: Costos de llamadas a la API de Claude (tracker de presupuesto)
CREATE TABLE IF NOT EXISTS costos_api (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rol VARCHAR(50) NOT NULL,
  modelo VARCHAR(100) NOT NULL,
  tipo_tarea VARCHAR(50),
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  tokens_cache_creation INTEGER DEFAULT 0,
  tokens_cache_read INTEGER DEFAULT 0,
  costo_estimado_usd NUMERIC(10,6) NOT NULL,
  placa VARCHAR(10),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_costos_api_created_at ON costos_api(created_at);
CREATE INDEX IF NOT EXISTS idx_costos_api_rol ON costos_api(rol);
CREATE INDEX IF NOT EXISTS idx_costos_api_placa ON costos_api(placa);

-- RLS habilitado sin políticas: igual que el resto de las tablas, solo el
-- backend con la service_role key (que bypassa RLS) puede leer/escribir.
ALTER TABLE costos_api ENABLE ROW LEVEL SECURITY;
