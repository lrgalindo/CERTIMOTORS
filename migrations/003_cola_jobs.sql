-- Tabla: Cola de jobs (procesamiento asíncrono de webhooks WhatsApp/Telegram)
-- Patrón ack-then-process: los webhooks insertan aquí y responden 200 de inmediato;
-- el worker (src/worker.js) hace polling y procesa fuera del ciclo request/response.

CREATE TABLE IF NOT EXISTS cola_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  proveedor VARCHAR(30) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pendiente',
  intentos INTEGER NOT NULL DEFAULT 0,
  max_intentos INTEGER NOT NULL DEFAULT 3,
  proximo_intento_en TIMESTAMP NOT NULL DEFAULT NOW(),
  error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT uq_cola_jobs_proveedor_external_id UNIQUE (proveedor, external_id)
);

CREATE INDEX IF NOT EXISTS idx_cola_jobs_status_proximo ON cola_jobs(status, proximo_intento_en);

-- RLS habilitado sin políticas: igual que costos_api, solo el backend con
-- la service_role key (que bypassa RLS) puede leer/escribir.
ALTER TABLE cola_jobs ENABLE ROW LEVEL SECURITY;

-- Reclamo atómico de jobs pendientes: FOR UPDATE SKIP LOCKED evita que, si en
-- el futuro corre más de una instancia del worker, dos reclamen el mismo job.
CREATE OR REPLACE FUNCTION reclamar_jobs_pendientes(p_limite INTEGER)
RETURNS SETOF cola_jobs
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE cola_jobs
  SET status = 'procesando', updated_at = NOW()
  WHERE id IN (
    SELECT id FROM cola_jobs
    WHERE status = 'pendiente' AND proximo_intento_en <= NOW()
    ORDER BY created_at ASC
    LIMIT p_limite
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;
