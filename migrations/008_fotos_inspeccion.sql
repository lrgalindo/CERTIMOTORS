-- Fotos crudas del mecánico, asociadas a hallazgos, para el registro
-- fotográfico del PDF v2. El bucket 'fotos-inspeccion' es privado y lo crea
-- el backend (db.asegurarBucketFotos); esta migración solo crea la tabla y
-- la purga de retención.

CREATE TABLE IF NOT EXISTS fotos_inspeccion (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  placa VARCHAR(10) NOT NULL REFERENCES ordenes(placa) ON DELETE CASCADE,
  punto INTEGER,
  caption TEXT,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fotos_inspeccion_placa ON fotos_inspeccion(placa);

-- RLS sin políticas: solo el backend con service_role, igual que el resto.
ALTER TABLE fotos_inspeccion ENABLE ROW LEVEL SECURITY;

-- Retención: purgar fotos crudas a los 120 días (90 de garantía + 30 de
-- margen). El PDF ya generado no se toca — lleva las fotos embebidas.
-- Nota: borrar de storage.objects vía SQL elimina los metadatos, con lo que
-- la foto deja de ser accesible por CUALQUIER API (privacidad cumplida).
-- El blob físico puede quedar huérfano en el object store ocupando espacio.
-- ponytail: purga por SQL; si el espacio del bucket crece, agregar un job de
-- Node que llame storage.remove() antes del DELETE.
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'purga-fotos-inspeccion',
  '0 3 * * *',
  $$
    DELETE FROM storage.objects
    WHERE bucket_id = 'fotos-inspeccion'
      AND name IN (
        SELECT storage_path FROM fotos_inspeccion
        WHERE created_at < NOW() - INTERVAL '120 days'
      );
    DELETE FROM fotos_inspeccion WHERE created_at < NOW() - INTERVAL '120 days';
  $$
);
