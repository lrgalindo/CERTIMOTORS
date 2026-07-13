# Revisión de seguridad — 8 Jul 2026

Estándar de evidencia: cada hallazgo indica cómo se verificó. ✅ = verificado en esta sesión.

## Higiene de secretos

- ✅ **Tokens de Telegram en `CLAUDE.md` están muertos.** Ambos tokens commiteados devuelven `401 Unauthorized` de `api.telegram.org/getMe` (probado 8 Jul). Ya fueron rotados en algún momento; la fuga es histórica e inerte. Se redactaron del archivo en esta sesión. **No hace falta reescribir la historia de git** — los valores expuestos no sirven.
- ✅ **Ningún otro secreto en archivos trackeados ni en la historia.** Escaneo de todos los blobs de `git rev-list --all` con patrones de `sk-ant-api03-`, `whsec_`, tokens de bot y tokens EAA de Meta: solo placeholders de `.env.example`. `.env` nunca fue commiteado.
- ⚠️ `pdf-approval.js:6` tiene el chat ID del admin hardcodeado como fallback (`8289807493`). Un chat ID no es un secreto (no permite enviar mensajes sin el bot token), se deja como está.

## Verificación de firmas de webhooks (producción)

Sondas reales contra `certimotors.onrender.com` con payloads vacíos sin firma (no encolan nada):

- ✅ `POST /webhook/whatsapp` sin firma → **401**. `WHATSAPP_APP_SECRET` está configurado y activo (el código tiene modo dev que dejaría pasar sin secreto; no está pasando).
- ✅ `POST /webhook/telegram/mecanico` sin header de secreto → **401**. Secreto de Telegram activo.
- ✅ `POST /webhook/recurrente` sin firma Svix → **401**. Fail-closed confirmado en producción.

## Idempotencia de webhooks

- ✅ **WhatsApp/Telegram:** dedupe por `UNIQUE (proveedor, external_id)` en `cola_jobs` (migración 003); `encolarJob` trata el 23505 como éxito. Retries del proveedor no duplican jobs.
- ✅ **Recurrente (corregido en esta sesión):** el webhook se procesa inline, y un replay dentro de la ventana anti-replay de 5 min repetía el mensaje de "pago confirmado" al cliente y la alerta Telegram al admin. Fix: guard de estado en `procesarPagoRecurrente` — si la orden ya avanzó más allá del pago, se ignora. Test: `procesarPagoRecurrente: replay del webhook no repite avisos si el pago ya se procesó`.

## RLS de Supabase (estado real, consultado vía API de administración)

Las 9 tablas de la app tienen **RLS habilitado con 0 políticas** — deny-by-default para `anon`/`authenticated`; el backend opera con la service_role key que bypassa RLS. Ese es el modelo correcto para esta arquitectura (una sola superficie: el backend). Las políticas `allow_all` de `init.sql` no existen en la base real.

El security advisor de Supabase reporta 3 hallazgos reales, cerrados por `migrations/007_seguridad_rls.sql` (**pendiente de confirmación de Rodrigo antes de aplicar**):

| Nivel | Hallazgo | Riesgo |
|---|---|---|
| ERROR | `cola_jobs_backup_20260707` sin RLS | Payloads de webhooks (mensajes de clientes) legibles con la anon key |
| ERROR | Vistas `orden_completa` y `estadisticas_diarias` como SECURITY DEFINER | Teléfonos y órdenes de clientes legibles con la anon key saltándose RLS |
| WARN | `reclamar_jobs_pendientes` ejecutable por `anon` | Cualquiera con la anon key puede marcar jobs como `procesando` (DoS de la cola) |

**Recomendación para el backoffice:** al ser rutas del mismo Express con service_role, no necesita políticas RLS propias; su control de acceso es la auth básica por variable de entorno (implementada en esta sesión).

## Autenticación del backoffice

Ver `src/backoffice.js`: HTTP Basic Auth contra `BACKOFFICE_USER`/`BACKOFFICE_PASS` (variables de entorno de Render), comparación en tiempo constante, 401 con `WWW-Authenticate` si faltan credenciales, y **fail-closed**: sin variables configuradas el backoffice responde 503 en vez de quedar abierto.
