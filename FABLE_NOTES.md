# FABLE_NOTES — lecciones de sesión (5 Jul 2026)

- El envío del PDF al cliente tras aprobación YA existía (`pdf-approval.js:enviarPdfWhatsapp`) — el brief asumía que faltaba. Leer el código antes de estimar bloques evita construir lo que ya está.
- `TELEGRAM_ADMIN_CHAT_ID` ya existía en `pdf-approval.js` con fallback hardcodeado — no era variable nueva, solo faltaba en `.env.example`.
- `ordenes.status` es `VARCHAR(50)`, no enum de Postgres — agregar estados nuevos NO requiere migración.
- `orden.servicio` nunca se escribía desde código: solo existía el DEFAULT de la migración 004. El cliente "elegía" servicio pero nada lo persistía — gap real que el brief no mencionaba.
- `standardHeaders: true` en `ratelimit.js` es opción de config de express-rate-limit, no naming del servicio — un grep ciego de "standard" lo habría roto.
- Para detectar "el cliente eligió un servicio" en texto libre, señales del agente (`[SERVICIO:X]`, `[ESCALAR]`) ganan a regex/NLU en código: el LLM ya está en el loop y distingue "quiero el full" de "¿qué incluye el full?"; el código solo ejecuta.
- Los botones interactivos de WhatsApp llevan el texto de Claude como `body`: un solo mensaje que es natural Y estructurado.
- El bug de "reinicia el saludo" tenía DOS causas: concurrencia (bloque 1) y que sin placa en el mensaje el código no recuperaba la orden activa del cliente.
- Recurrente firma webhooks con el estándar Svix — verificable con `node:crypto` puro, sin dependencia nueva. En un endpoint de pago: fail-closed y ventana anti-replay, sin excepción "modo dev".

## Lecciones del Bloque 4 — QA y cierre documental

- Un test de naming con exclusiones quirúrgicas es mejor que uno prohibicionista: `migrations/004_certificado_pdf.sql` necesita el valor viejo para ser un registro histórico fiel; excluirlo por nombre de archivo es más robusto que intentar limpiar la migración histórica.
- La diferencia entre "verificado por test" y "verificado por lectura de código" importa más que el número total de flujos cubiertos. Reportar ambos como "verificados" sería mentira; la honestidad del QA_RESULTS tiene valor en sí misma para futuros agentes.
- Los flujos que dependen del LLM (mensajes ambiguos, respuesta "tarjeta de circulación") no se pueden cubrir con tests de unidad sin mockear Claude — y mockear Claude para verificar que Claude sigue instrucciones no prueba nada real. Mejor declararlo como pendiente de prueba manual que fingir cobertura.
- Los archivos `.env.example` pueden estar protegidos por el sistema de permisos del harness. Ante una denegación, la respuesta correcta es documentar las líneas pendientes en el PR body y no insistir.
- El regex de patrones prohibidos debe aplicarse línea a línea con `lastIndex = 0` después de cada test cuando se usa la flag `g`; de lo contrario el estado del regex entre líneas produce falsos negativos silenciosos.

## Lecciones de la sesión de staging (8-9 Jul 2026)

- `REVOKE EXECUTE ... FROM anon, authenticated` no cierra nada en Postgres: las funciones dan EXECUTE a PUBLIC por default (`=X/` en proacl). Hay que revocar PUBLIC también. Lo encontró el dry-run contra el esquema real, no la lectura del SQL.
- Supabase branching requiere plan Pro. El equivalente en Free: correr la migración completa en producción dentro de `BEGIN...ROLLBACK` (con el ROLLBACK escrito ANTES de mandar el script) y verificar el estado resultante con una temp table dentro de la misma transacción.
- pdfkit: ✓/✗ no existen en WinAnsi y ZapfDingbats mapea esos code points a otros glifos (molinetes). Marcas de checklist → dibujarlas con vectores (2-3 strokes), nunca con texto.
- El 97% del gasto de Claude ($6.77 de $6.95) fue UN número de spam en un día. `NUMEROS_BLOQUEADOS` lo frenó, pero la lección estructural es el tope diario de mensajes por número antes de llamar a Claude.
- El `cache_control` en el system prompt del cliente casi no pega (cache_read promedio 158 vs creation 1,703): el historial embebido invalida el caché en cada mensaje. Partir en bloque estático cacheado + contexto dinámico aparte.
- La verificación con subagente fresco por bloque encontró en cada bloque algo que el autor no vio (estados sin cubrir en tests, ACL de PUBLIC, comentario de migración falso sobre reconciliación de Storage). Vale el costo; con Sonnet alcanza.
