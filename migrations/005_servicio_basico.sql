-- Renombra el servicio ESTANDAR a BASICO (decisión de producto Jul 2026: BÁSICO Q550 / FULL Q1,200).
-- La migración 004 queda como registro histórico; esta corrige el default y los datos existentes.
ALTER TABLE ordenes ALTER COLUMN servicio SET DEFAULT 'BASICO';
UPDATE ordenes SET servicio = 'BASICO' WHERE servicio = 'ESTANDAR';
