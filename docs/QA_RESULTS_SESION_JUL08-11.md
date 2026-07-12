# QA_RESULTS — Sesión staging/sesion-jul08 (8–11 Jul 2026)

Estándar: ✅ verificado con evidencia real en esta sesión · ⚠️ sin poder verificar en vivo
(con el porqué) · ❌ no alcanzado. Cada bloque grande fue auditado por un subagente de
contexto fresco antes de marcarse cerrado; sus hallazgos menores están corregidos y
commiteados.

**Resultado en una oración: el sistema quedó funcional y endurecido en staging —
seguridad cerrada con el advisor de Supabase en verde, PDF v2 con fotos, backoffice,
máquina de estados de conversación validada en vivo, y el bug del "No" del mecánico
corregido con la secuencia exacta del incidente; lo único que NO quedó demostrado
end-to-end es el disparo del webhook de pago contra producción (falta el secreto, 5
minutos de tu terminal) y las credenciales reales de Recurrente para lanzamiento.**

---

## 1. Seguridad ✅

- ✅ Tokens de Telegram commiteados en CLAUDE.md **están muertos** (401 de la API de
  Telegram, probado). Redactados del archivo. Historia de git limpia de secretos vivos
  (escaneo completo de blobs).
- ✅ Los 3 webhooks de producción rechazan requests sin firma (sondas reales → 401).
- ✅ Webhook de Recurrente ahora idempotente ante replays (guard de estado + tests).
- ✅ Migración 007 aplicada en producción **con dry-run previo en transacción con
  ROLLBACK** (no hay branching en el plan Free). Hallazgo del dry-run: había que
  revocar `PUBLIC`, no solo `anon/authenticated`. Advisor re-corrido: los 3 hallazgos
  (backup sin RLS, vistas SECURITY DEFINER, RPC ejecutable por anon) **cerrados**;
  solo quedan INFO esperados (RLS sin políticas = deny-by-default con service_role).
- Detalle completo: `docs/SECURITY_REVIEW_2026-07-08.md`.

## 2. QA de flujos con evidencia ✅

- ✅ Suite: **115/115** (74 al inicio del proyecto, 105 al abrir la sesión).
- ✅ 6 pruebas de tono en vivo contra Claude real: 5 pasaron de entrada; la 1 ("hola"
  con orden activa debe saludar antes de informar) falló, fix de una línea al prompt
  aprobado por Rodrigo, re-validada: `"¡Hola! Seguimos con la P123ABC — ¿ya pudiste
  revisar el link de pago?"`.
- ✅ P926FTB re-reportada (2 revisiones reales en Supabase) y su cierre validado junto
  con el fix del punto 6.
- Gasto de pruebas en vivo: **~$0.13 de $1.00** autorizado.

## 3. Backoffice ✅

- ✅ `/backoffice` solo lectura: órdenes (filtro status/placa), cola_jobs, gasto
  Claude, clientes. Basic Auth en tiempo constante, fail-closed (503 sin env vars),
  HTML escapado (test anti-XSS). Auditado.
- ⚠️ Verificación visual en producción pendiente de deploy + configurar
  `BACKOFFICE_USER`/`BACKOFFICE_PASS` en Render.

## 4. PDF v2 ✅ (artefactos generados y verificados visualmente)

- ✅ Muestras generadas y revisadas página por página: BÁSICO (4 págs) y FULL con
  fotos (5 págs). Badges de servicio, grilla de hasta 6 fotos con caption, página
  legal con 4 bloques modulares (badge OK/PRECAUCIÓN, fuente, callout "qué significa
  esto para vos"), checklist completo con marcas vectoriales ✓/!/✗ (los glifos no
  existen en las fuentes de pdfkit — hallado en la verificación visual), vigencia con
  fechas concretas, caja "verificá físicamente" VIN/chasis/motor.
- ✅ Fotos del mecánico: se suben a bucket privado `fotos-inspeccion` asociadas al
  hallazgo (validado con test de flujo completo). Migración 008 aplicada (tabla +
  pg_cron de purga a 120 días).
- ⚠️ La purga por SQL borra metadatos (la foto deja de ser accesible = privacidad
  cumplida) pero el blob físico puede quedar huérfano ocupando espacio — documentado
  en la migración con el upgrade path.

## 5. API_CONTRACT_WEB.md ✅

- ✅ Escrito desde el diseño real (campos y zonas con recargo extraídos del HTML del
  prototipo). Auditado contra el código: precios, firma de `crearCheckoutRecurrente`,
  idempotencia del webhook y cobertura de la migración 004 confirmados. 7 gaps de
  esquema señalados sin implementar. Cero código de frontend tocado.

## 6. Eficiencia ✅

- ✅ Hallazgo principal con datos reales: **97% del gasto histórico de Claude ($6.77
  de $6.95) fue un solo número de spam en un día**; el bloqueo del PR #13 lo frenó
  (cero mensajes desde el merge). Recomendación documentada: tope diario por número.
- ✅ Caché de prompt casi sin efecto (lectura promedio 158 tokens vs escritura 1,703):
  el historial embebido lo invalida. Optimización documentada, no aplicada (toca zona
  protegida y merece su propia validación de tono).
- ✅ Código muerto eliminado (5 funciones + tests), ramas locales mergeadas borradas,
  inventario de 10 tablas. Detalle: `docs/EFICIENCIA_2026-07-09.md`.

## 7. Flujo de pago — **verificado en sandbox, NO listo para producción** ⚠️

- ✅ Confirmado en la documentación oficial de Recurrente: las llaves distinguen
  ambiente por prefijo (`sk_test_*`/`pk_test_*` vs `sk_live_*`/`pk_live_*`), la
  tarjeta de prueba del sandbox es `4242 4242 4242 4242`, y **los webhooks NO se
  envían para checkouts creados con llaves de test** — el pago sandbox por sí solo
  nunca moverá una orden.
- ⚠️ No pude confirmar por lectura directa qué prefijo tienen las llaves en Render
  (no tengo acceso); **verificá que empiecen con `sk_test_`** para confirmar que es
  sandbox.
- ✅ La ruta del webhook (firma Svix, idempotencia, transición a PAGO_CONFIRMADO,
  aviso WhatsApp) está cubierta por tests firmados localmente.
- ⚠️ El disparo E2E contra producción quedó a 5 minutos de tu terminal: la orden de
  prueba `T111TST` existe en `ESPERANDO_PAGO` asociada a tu número, y el simulador
  firmado está listo — el secreto solo vive en Render:
  `RECURRENTE_WEBHOOK_SECRET=whsec_... node scripts/simular-webhook-recurrente.mjs T111TST`
  Debe responder 200, mover T111TST a PAGO_CONFIRMADO y mandarte el WhatsApp.
- ❌ **Pendiente para lanzamiento (fuera de esta sesión):** configurar llaves
  `sk_live_*` reales, registrar el endpoint de webhook en Recurrente (el
  `signingSecret` se devuelve al crearlo), y una transacción mínima real con
  reembolso el mismo día.

## 8. Bug del "No" del mecánico ✅

- ✅ Causa raíz: cada mensaje era un turno aislado — el bot no recordaba su propia
  pregunta de confirmación. Fix: último mensaje del bot por mecánico como contexto
  (+ instrucción para sí/no breves + el contexto se descarta al cerrar la inspección).
- ✅ Validado con la **secuencia exacta del incidente** contra Claude real (2 corridas):
  2 hallazgos → "ninguna adicional" → resumen + "¿Confirmás que terminaste…?" →
  **"No"** → "Dale, ¿qué sigue?" — sin cerrar la inspección ni pedir reformulación.

## 9. Máquina de estados de conversación ✅ (DoD propio)

- ✅ Un solo prompt, `persona_activa` inyectada (opción a, confirmada por Rodrigo).
  `estado_conversacion` JSONB en `clientes` (migración 009 aplicada, columna
  verificada). El código —no el LLM— calcula etapa y `campos_faltantes`.
- ✅ E2E en vivo (6 turnos, Claude real): el agente pide solo lo que falta, sin
  repetir preguntas; etapas avanzan 1_plan → 2_contacto → 3_vehiculo_zona →
  4_agendamiento con cada dato.
- ✅ Dato ambiguo: "creo que es como del 2018" → el agente NO emitió `[DATO:anio]` y
  pidió confirmar; "ya lo confirmé: es 2018" → `anio=2018` escrito.
- ✅ `monto_confirmado=false` bloquea el link de pago (gate en código + test: pregunta
  de precio no genera link; elección explícita sí).
- ✅ Latencia loggeada por etapa (muestra real: 2.2–3.9s por turno).
- ✅ El E2E encontró y corrigió un bug real: `es_dueno=false` contaba como faltante.
- ⚠️ La persistencia por el code path real contra Supabase no pudo ejercitarse
  localmente (no hay `SUPABASE_KEY` en el `.env` local); la función está testeada con
  fake, la columna existe, y el primer mensaje real tras el deploy la ejercita — con
  fallback best-effort que no rompe nada si fallara.

---

## Pendientes para la próxima sesión / lanzamiento

1. **Recurrente producción:** llaves `sk_live_*`, endpoint de webhook registrado,
   transacción mínima real con reembolso. (Punto 7 — lo único bloqueante para lanzar.)
2. Disparo del simulador de webhook desde tu terminal (5 min, cierra el E2E sandbox).
3. Variables nuevas en Render: `BACKOFFICE_USER`, `BACKOFFICE_PASS`.
4. Verificación visual del backoffice y del primer certificado PDF v2 real tras deploy.
5. Borrado de ramas remotas mergeadas y de `cola_jobs_backup_20260707` (destructivos,
   comandos documentados en `docs/EFICIENCIA_2026-07-09.md`).
6. Opcional documentado: tope diario de mensajes por número; partir el prompt para
   caché (~40-60% de ahorro estimado).
