-- Migración 005: columnas para órdenes originadas en el checkout web
-- Todas las columnas son ADD IF NOT EXISTS — aditivas, no rompen el flujo WhatsApp existente.

ALTER TABLE ordenes
  ADD COLUMN IF NOT EXISTS canal_origen           VARCHAR(20)  DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS nombre_cliente         VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email                  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS zona                   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS fecha_preferida        DATE,
  ADD COLUMN IF NOT EXISTS recurrente_checkout_id TEXT;

-- Índice único sparse: aplica solo a filas donde recurrente_checkout_id no es NULL.
-- Las órdenes de WhatsApp (NULL) no colisionan entre sí.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ordenes_recurrente_checkout
  ON ordenes(recurrente_checkout_id)
  WHERE recurrente_checkout_id IS NOT NULL;
