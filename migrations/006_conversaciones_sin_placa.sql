-- Permite guardar conversaciones antes de que el cliente dé su placa.
-- La FK a ordenes(placa) sigue aplicando cuando placa no es NULL.
ALTER TABLE conversaciones ALTER COLUMN placa DROP NOT NULL;
