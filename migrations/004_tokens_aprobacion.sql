-- Tokens de un solo uso para callbacks de aprobación/corrección de certificados
CREATE TABLE IF NOT EXISTS tokens_aprobacion (
  token      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placa      TEXT NOT NULL REFERENCES ordenes(placa),
  usado      BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tokens_aprobacion_placa ON tokens_aprobacion(placa);
CREATE INDEX IF NOT EXISTS idx_tokens_aprobacion_usado  ON tokens_aprobacion(token) WHERE usado = false;
