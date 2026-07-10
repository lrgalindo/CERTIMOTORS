-- Cierra los 3 hallazgos del security advisor de Supabase (8 Jul 2026).
-- El backend usa la service_role key (bypassa RLS), así que nada de esto
-- afecta a la app: solo cierra el acceso vía anon/authenticated por PostgREST.

-- 1. La tabla de backup del incidente P0 quedó sin RLS: legible con la anon key.
ALTER TABLE cola_jobs_backup_20260707 ENABLE ROW LEVEL SECURITY;

-- 2. Las vistas heredadas de init.sql corren como SECURITY DEFINER y exponen
--    teléfonos de clientes saltándose RLS. security_invoker las somete a las
--    políticas del que consulta (anon sin políticas = sin acceso).
ALTER VIEW orden_completa SET (security_invoker = true);
ALTER VIEW estadisticas_diarias SET (security_invoker = true);

-- 3. El RPC de reclamo de jobs era ejecutable por anon/authenticated:
--    cualquiera con la anon key podía marcar jobs como 'procesando'.
--    PUBLIC va incluido: Postgres da EXECUTE a PUBLIC por default y revocar
--    solo anon/authenticated no cierra nada (verificado en proacl 8 Jul 2026).
--    service_role conserva su grant explícito — el worker no se ve afectado.
REVOKE EXECUTE ON FUNCTION reclamar_jobs_pendientes(integer) FROM PUBLIC, anon, authenticated;

-- Reversa (si algo fallara): ALTER TABLE ... DISABLE ROW LEVEL SECURITY;
-- ALTER VIEW ... SET (security_invoker = false); GRANT EXECUTE ... TO PUBLIC;
