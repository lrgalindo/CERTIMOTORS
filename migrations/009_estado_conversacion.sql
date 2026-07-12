-- Estado explícito de conversación del agente de WhatsApp (máquina de estados).
-- Va en clientes y no en ordenes: las etapas 0-3 (bienvenida, plan, contacto,
-- vehículo/zona) ocurren antes de que exista una orden, igual que el historial
-- pre-placa que ya vive asociado al cliente.
-- Reversa: ALTER TABLE clientes DROP COLUMN estado_conversacion;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS estado_conversacion JSONB;
