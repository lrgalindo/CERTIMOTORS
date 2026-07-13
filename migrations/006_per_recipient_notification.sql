-- Tracking de notificación por destinatario en ordenes.
-- Antes: un solo notificado_at marcaba "todo el equipo fue notificado" (all-or-nothing).
-- Problema: si el tramitador fallaba, el job se reintentaba completo → el mecánico
--           recibía mensajes duplicados en cada reintento.
-- Solución: marcar cada destinatario individualmente tan pronto como su envío tenga éxito.
--           El worker omite destinatarios ya marcados en reintentos posteriores.
--           notificado_at sigue siendo el marcador de "completado" para la query de reconciliación.

ALTER TABLE ordenes
  ADD COLUMN IF NOT EXISTS mecanico_notificado_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tramitador_notificado_at  TIMESTAMPTZ;

COMMENT ON COLUMN ordenes.mecanico_notificado_at   IS 'Timestamp exacto en que el bot mecánico recibió la notificación. NULL = aún pendiente.';
COMMENT ON COLUMN ordenes.tramitador_notificado_at IS 'Timestamp exacto en que el bot tramitador recibió la notificación (solo aplica servicio FULL). NULL = aún pendiente.';
