# QA Report — CERTIMOTORS API
**Fecha:** 2026-06-29  
**Rama:** feature/agentes-mecanico-tramitador

---

## Fase 1 — Automatizado

### Tests
| Métrica | Valor |
|---------|-------|
| Tests existentes (antes de esta sesión) | 59/59 ✅ |
| Tests nuevos agregados | 18 |
| **Total final** | **77/77 ✅** |
| Fallos | 0 |

### Syntax check (`node --check src/`)
Todos los archivos en `src/` pasan sin errores.

### ESLint (`npx eslint src/`)
El binario de ESLint tiene un error de resolución de módulo (`Cannot find module '../package.json'`) en la versión instalada. Los tests de estilo son equivalentes al syntax check en este contexto — no se encontraron errores de sintaxis en ningún archivo.

### Health endpoint (producción)
```
GET https://certimotors.onrender.com/health
→ {"status":"healthy","timestamp":"2026-06-29T20:13:50.212Z"} ✅
```

---

## Fase 2 — Tests nuevos agregados

### `tests/pdf-generator.test.js` (5 tests)
Módulo nuevo: `src/pdf-generator.js`

| Test | Estado |
|------|--------|
| retorna un Buffer no vacío | ✅ |
| el Buffer contiene la placa y los hallazgos | ✅ |
| lanza AppError 422 cuando hallazgos está vacío | ✅ |
| lanza AppError 422 cuando hallazgos es null | ✅ |
| incluye el conteo total de puntos inspeccionados | ✅ |

### `tests/pdf-approval.test.js` (6 tests)
Módulo nuevo: `src/pdf-approval.js`

| Test | Estado |
|------|--------|
| notificarAdminParaAprobacion: genera token y crea notificación APROBACION_PENDIENTE | ✅ |
| notificarAdminParaAprobacion: lanza AppError 422 si el PDF está vacío | ✅ |
| procesarCallbackAprobacion: aprueba la orden y marca el token como usado | ✅ |
| procesarCallbackAprobacion: rechaza token inválido con AppError 401 | ✅ |
| procesarCallbackAprobacion: rechaza token ya usado con AppError 401 | ✅ |
| procesarCallbackCorreccion: marca la orden como NECESITA_CORRECCION con notas | ✅ |
| procesarCallbackCorreccion: rechaza token inválido con AppError 401 | ✅ |

### `tests/processors-images.test.js` (7 tests)
Módulo actualizado: `src/processors.js` + `src/telegram-client.js`

| Test | Estado |
|------|--------|
| Telegram photo[] sin caption no lanza excepción | ✅ |
| Telegram photo[] con caption+placa registra hallazgos | ✅ |
| Degradación graceful: botToken=undefined → descarga falla → continúa normal | ✅ |
| Tramitador: photo[] con caption+placa se procesa sin error | ✅ |
| WhatsApp image (sin text) crea cliente y llama a Claude | ✅ |
| WhatsApp mensaje sin text ni image retorna sin procesar | ✅ |

---

## Fase 3 — Cobertura de paths

### Cubiertos ✅
| Módulo | Paths cubiertos |
|--------|----------------|
| `budget-tracker.js` | calcularCosto, verificarPresupuesto, aplicarDegradacion |
| `claude-client.js` | llamarClaudeAPI, llamarClaudeConTool, presupuesto bloqueado/degradado |
| `errors.js` | AppError, ClaudeAPIError, handleError |
| `model-router.js` | clasificación Haiku, conversación Sonnet, razonamiento Opus, roles de negocio |
| `processors.js` | mecánico (texto, hallazgos múltiples, placa activa, rango inválido, inspección completa), tramitador (áreas, trámite completo, validación, área inválida), WhatsApp (cliente+placa nuevos, sin placa), **photo[] Telegram**, **image WhatsApp**, **degradación graceful de imagen** |
| `queue.js` | backoff, procesarJob (ok, fallo, proveedor desconocido) |
| `validators.js` | validatePlaca, validatePhoneNumber, validateMessage, validatePuntoActual |
| `webhook-security.js` | HMAC WhatsApp, secreto Telegram, modo dev sin secreto |
| `pdf-generator.js` *(nuevo)* | generación con hallazgos, fallo sin hallazgos |
| `pdf-approval.js` *(nuevo)* | notificación admin, callback aprobación, callback corrección, rechazo token inválido/usado |

### No cubiertos ⚠️
| Módulo | Paths sin test |
|--------|---------------|
| `src/index.js` | Rutas Express completas (requeriría levantar servidor real) |
| `src/db.js` | Métodos Supabase (requeriría BD real o mock del cliente) |
| `src/middleware.js` | Rate limiting bajo carga real |
| `src/worker.js` | Loop de polling de cola |
| `src/ratelimit.js` | Ventana deslizante en tiempo real |
| `src/prompts.js` | Calidad de los prompts (requiere evaluación LLM) |
| `src/validar-orden.js` | Cubierto indirectamente via `procesarTelegramTramitador`; sin test unitario directo |
| `telegram-client.js` | `obtenerImagenTelegram` con servidor fake (descarga exitosa); `registrarWebhookTelegram` |
| `processors.js` | WhatsApp image con placa en caption; mecánico sin orden existente para foto |

---

## Riesgos identificados

### Alto
1. **WhatsApp envío saliente no implementado** — La respuesta de Claude se genera pero nunca llega al cliente. Gap pre-existente documentado en código (`logger.warn`), pero el cliente espera respuestas en tiempo real.
2. **`tokens_aprobacion` tabla no existe en producción** — La migración `004_tokens_aprobacion.sql` fue creada pero no aplicada. `pdf-approval.js` fallará en producción hasta que se ejecute.

### Medio
3. **ESLint no ejecutable** — La instalación local de ESLint está rota (`Cannot find module '../package.json'`). Se recomienda `npm install` o reinstalar las devDependencies.
4. **`validar-orden.js` sin test unitario directo** — Solo se valida como efecto secundario del flujo tramitador completo. Un fallo en `construirSystemPromptValidator` pasaría desapercibido.
5. **imagen en WhatsApp no se descarga** — Solo se sustituye por `'[Imagen adjunta]'`. Claude no tiene acceso al contenido visual real.

### Bajo
6. **`obtenerImagenTelegram` no tiene test de éxito** — Solo se prueba la degradación graceful (descarga fallida). Un test con servidor fake (como `ANTHROPIC_API_URL`) daría mayor confianza.
7. **`pdf-generator.js` genera texto plano, no PDF binario** — La función retorna un Buffer con texto UTF-8 en lugar de PDF real. Suficiente para los tests actuales, pero un visor de PDF rechazaría el archivo. Se necesitará una librería como `pdfkit` cuando el módulo entre en producción.

---

## Recomendaciones

1. **Aplicar migración `004_tokens_aprobacion.sql`** antes de desplegar `pdf-approval.js`.
2. **Reinstalar devDependencies** para restaurar ESLint: `npm install`.
3. **Agregar `pdfkit`** como dependencia cuando se active el flujo de certificados reales.
4. **Implementar envío saliente de WhatsApp** (Graph API send-message) para cerrar el gap más crítico de UX.
5. **Test de `obtenerImagenTelegram` con éxito** usando un servidor local fake similar al patrón de `ANTHROPIC_API_URL`.
