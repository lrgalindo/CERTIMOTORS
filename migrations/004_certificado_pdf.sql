-- Datos del vehículo e inspector necesarios para el certificado PDF,
-- y referencia al PDF generado en Supabase Storage.
ALTER TABLE ordenes
  ADD COLUMN IF NOT EXISTS marca VARCHAR(100),
  ADD COLUMN IF NOT EXISTS modelo VARCHAR(100),
  ADD COLUMN IF NOT EXISTS anio INTEGER,
  ADD COLUMN IF NOT EXISTS kilometraje INTEGER,
  ADD COLUMN IF NOT EXISTS inspector_nombre VARCHAR(255),
  ADD COLUMN IF NOT EXISTS servicio VARCHAR(20) DEFAULT 'ESTANDAR',
  ADD COLUMN IF NOT EXISTS certificado_url TEXT,
  ADD COLUMN IF NOT EXISTS certificado_generado_at TIMESTAMP;
