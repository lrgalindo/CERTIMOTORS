# CLAUDE.md — CERTIMOTORS

Contexto verificado contra el código real en `main` (no aspiracional). Léelo antes de tocar nada; si algo aquí contradice el código, el código gana y este archivo debe corregirse.

## 1. Descripción del proyecto y modelo de negocio

CERTIMOTORS es una plataforma de certificación de vehículos usados en Guatemala. El flujo de negocio:

1. Un **cliente** contacta por WhatsApp para certificar su vehículo (placa formato `P926FTB`).
2. Un **mecánico** hace una inspección de **110 puntos** sobre el vehículo, reportando hallazgos por Telegram en lenguaje natural (no formulario fijo).
3. Un **tramitador** verifica 4 áreas administrativas obligatorias (impuesto de circulación, calcomanía electrónica, multas de tránsito, gravámenes de garantías mobiliarias), también por Telegram.
4. Al completarse la inspección y/o el trámite, el sistema genera automáticamente un **certificado PDF** de 2 o 3 páginas con el dictamen para el cliente final.
5. Hay dos niveles de servicio por orden: `ESTANDAR` (certificado se genera al completar la inspección mecánica, sin página administrativa) y `FULL` (certificado se genera al completar el trámite administrativo, con página administrativa adicional).

Tres canales de entrada: WhatsApp (cliente), Telegram bot "mecánico", Telegram bot "tramitador" — son bots separados con tokens y secretos de webhook independientes.

## 2. Stack y arquitectura real

- **Runtime**: Node.js ≥18, ESM puro (`"type": "module"` en `package.json`).
- **Framework HTTP**: Express 4.
- **IA**: API de Claude (Anthropic) llamada directamente vía `axios` (NO se usa el SDK oficial `@anthropic-ai/sdk`).
- **Persistencia**: Supabase (PostgreSQL) vía `@supabase/supabase-js`, más Supabase Storage para los PDFs (bucket `certificados`, con fallback a `/tmp` si Storage falla).
- **PDF**: `pdfkit` (genera certificados) + `qrcode` (QR de verificación embebido).
- **Mensajería saliente**: Telegram vía `axios` directo a la Bot API (`api.telegram.org`). **WhatsApp saliente NO está implementado** — ver sección 10.
- **Procesamiento asíncrono**: patrón ack-then-process. Los webhooks insertan un job en la tabla `cola_jobs` y responden 200 de inmediato; `src/worker.js` hace polling (`setInterval`) y procesa fuera del ciclo request/response, con reintentos y backoff exponencial.
- **No hay framework de jobs externo** (no Bull/BullMQ/Redis) — la cola vive enteramente en Postgres, con reclamo atómico vía `FOR UPDATE SKIP LOCKED` (función `reclamar_jobs_pendientes` en `003_cola_jobs.sql`).
- **Testing**: `node --test` nativo (sin Jest/Mocha). 59 tests en 8 archivos bajo `tests/`.
- **Lint/format**: ESLint 8 + Prettier 3.

Arquitectura de carpetas real:
```
src/
  index.js            Entry point Express: rutas, webhooks, arranque del worker
  worker.js           Loop de polling de cola_jobs, despacha a los processors
  processors.js       Lógica de negocio por canal (whatsapp, telegram_mecanico, telegram_tramitador)
  validar-orden.js    Validación QA antes de certificar (rol "validator")
  pdf-generator.js    Generación del certificado PDF (rol "certificado")
  prompts.js          System prompts de los 5 roles de IA
  tools.js            Tool schemas (input_schema) forzados vía tool_choice
  claude-client.js    Llamadas HTTP a la API de Claude + integración con presupuesto
  model-router.js     Selección de modelo/max_tokens/pricing por rol
  budget-tracker.js   Cálculo de costo, gasto mensual y degradación de modelo
  db.js               Único punto de acceso a Supabase (todas las queries)
  queue.js            Constantes de concurrencia/polling + cálculo de backoff
  telegram-client.js  Envío de mensajes y registro de webhook en Telegram
  webhook-security.js Verificación de firma WhatsApp (HMAC) y secreto Telegram
  validators.js       Validación de placa/teléfono/mensaje/punto
  errors.js           AppError / ClaudeAPIError + handler de errores HTTP
  logger.js           Logger mínimo sobre console.*
  ratelimit.js         Rate limiter usado realmente por index.js (100 req/15min)
  middleware.js       Rate limiter + healthEndpoint + requestLogger — código MUERTO, no se importa desde index.js (ver sección 10)
```

## 3. Módulos principales — responsabilidad real

- **`index.js`**: define `CONFIG` desde env vars, monta rutas (`/`, `/health`, `/metrics`, webhooks de WhatsApp/Telegram, `/api/validar-orden`, `/api/reporte-diario`), 404 handler, error handler, y `start()` que inicializa DB, levanta el servidor, arranca el worker y opcionalmente registra los webhooks de Telegram contra la API de Telegram si `TELEGRAM_AUTO_REGISTER_WEBHOOK === 'true'`.
- **`processors.js`**: contiene la lógica real de los 3 canales. `procesarWhatsapp` crea/recupera cliente y orden, llama a Claude (texto libre, rol `cliente`) y **registra la respuesta en BD pero no la envía** (ver sección 10). `procesarTelegramMecanico` resuelve la placa activa si el mecánico no la repite, llama a Claude forzando el tool `registrar_inspeccion`, persiste cada hallazgo válido, y si `inspeccion_completa` es true marca la orden y — solo si `servicio !== 'FULL'` — dispara `generarCertificado`. `procesarTelegramTramitador` llama a Claude forzando `registrar_avance_tramite`, persiste cada actualización válida como notificación, y si `tramite_completo` es true dispara `validarOrden` y luego `generarCertificado` (siempre, sin importar el servicio).
- **`validar-orden.js`**: calcula `completadas/110` y pide a Claude (rol `validator`) un veredicto de texto libre. No bloquea la generación del certificado si falla (los processors capturan el error y solo loguean).
- **`pdf-generator.js`**: dedupe de revisiones (última por punto), arma el texto de hallazgos y verificaciones, llama a Claude forzando `generar_certificado` (rol `certificado`, modelo Haiku) para clasificar categorías y redactar veredictos en lenguaje de cliente, calcula veredicto final (`calcularVeredicto`), genera código de certificado, dibuja 2 o 3 páginas con `pdfkit` (`bufferPages: true` + `bufferedPageRange()` para el pie "Página X de Y"), sube a Supabase Storage (bucket `certificados`) con fallback a `/tmp`, y guarda la URL en la orden.
- **`claude-client.js`**: única puerta de salida hacia la API de Claude. Verifica presupuesto antes de llamar, selecciona y degrada el modelo, llama `axios.post` con `cache_control: ephemeral` en el system prompt, registra el costo real vía `budget-tracker.registrarLlamada`. Expone `llamarClaudeAPI` (texto libre) y `llamarClaudeConTool` (fuerza `tool_choice` y devuelve el `input` ya parseado, sin segundo round-trip).
- **`db.js`**: capa única de acceso a Supabase; cada función envuelve una query y lanza error si Supabase devuelve error (excepto `PGRST116` = "no rows", que se trata como `null` válido).
- **`worker.js`**: `tick()` reclama jobs pendientes (`QUEUE_CONCURRENCY`), los procesa con `Promise.allSettled`, marca completado o reprograma con backoff exponencial (`calcularBackoffMs = 1000 * 2^(intentos-1)`).

## 4. Esquema de base de datos (4 migraciones aplicadas)

**`migrations/init.sql`** — esquema base:
- `clientes(id, numero_telefono UNIQUE, nombre, tipo, created_at, updated_at)`
- `ordenes(id, placa UNIQUE, cliente_id FK, tipo_auto, status DEFAULT 'INICIADA', created_at, updated_at)`
- `conversaciones(id, placa FK, cliente_id FK, tipo_usuario, mensaje_entrada, respuesta_ia, tokens_usados, created_at)`
- `revisiones(id, placa FK, mecanico_id, punto_actual, respuesta, created_at)`
- `notificaciones(id, placa FK, tipo, mensaje, enviado BOOLEAN DEFAULT false, created_at)`
- Vistas `orden_completa` y `estadisticas_diarias`. RLS habilitado en clientes/ordenes/conversaciones con política `allow_all` (desarrollo, no producción real).

**`migrations/002_costos_api.sql`** — tracking de costo de IA:
- `costos_api(id, rol, modelo, tipo_tarea, tokens_input, tokens_output, tokens_cache_creation, tokens_cache_read, costo_estimado_usd NUMERIC(10,6), placa, created_at)`. RLS habilitado sin políticas (solo accesible vía service_role key del backend).

**`migrations/003_cola_jobs.sql`** — cola de procesamiento asíncrono:
- `cola_jobs(id, proveedor, external_id, payload JSONB, status DEFAULT 'pendiente', intentos, max_intentos DEFAULT 3, proximo_intento_en, error, created_at, updated_at)` con `UNIQUE(proveedor, external_id)` (deduplica reintentos de webhook).
- Función `reclamar_jobs_pendientes(p_limite)`: `UPDATE ... FOR UPDATE SKIP LOCKED` para reclamo atómico multi-instancia.

**`migrations/004_certificado_pdf.sql`** — datos para el PDF:
- `ALTER TABLE ordenes ADD COLUMN marca, modelo, anio, kilometraje, inspector_nombre, servicio VARCHAR(20) DEFAULT 'ESTANDAR', certificado_url, certificado_generado_at`.

> ⚠️ Pendiente: `004_certificado_pdf.sql` aún no se ha aplicado en el Supabase de producción (no hay credenciales en este sandbox para hacerlo). Debe ejecutarse manualmente en el SQL Editor de Supabase, y debe correrse `scripts/crear-bucket-certificados.js` (o dejar que `asegurarBucketCertificados()` lo haga en el primer certificado) para crear el bucket `certificados` en Storage.

## 5. Los 2 agentes con tool_choice forzado — schemas reales y flujo

CERTIMOTORS tiene 5 roles de IA en total (`cliente`, `mecanico`, `tramitador`, `validator`, `reporter`, `certificado` — 6 contando certificado), pero solo **2 usan `llamarClaudeConTool`** (tool_choice forzado, sin texto libre):

### Agente Mecánico (`registrar_inspeccion`, en `src/tools.js`)
- Forzado en `procesarTelegramMecanico` (`processors.js`).
- `input_schema`: `respuesta_mecanico` (string, requerido), `hallazgos[]` (array, default `[]`, cada uno `{ punto: int 1-110, nombre_punto, estado: BIEN|REGULAR|MAL, observacion }`, requiere `punto` y `estado`), `inspeccion_completa` (boolean, default `false`).
- Flujo: el mecánico escribe en lenguaje libre por Telegram → Claude interpreta y extrae N hallazgos en una sola llamada → cada hallazgo se valida (`punto` 1-110, `estado` en enum) y se persiste en `revisiones` como string `"ESTADO - nombre - observacion"` → si `inspeccion_completa`, se marca la orden `INSPECCION_COMPLETA`, se registra `inspector_nombre`, y si `servicio !== 'FULL'` se dispara `generarCertificado` inline (try/catch, no bloquea la respuesta al mecánico).

### Agente Tramitador (`registrar_avance_tramite`, en `src/tools.js`)
- Forzado en `procesarTelegramTramitador` (`processors.js`).
- `input_schema`: `respuesta_tramitador` (string, requerido), `actualizaciones[]` (array, default `[]`, cada uno `{ area: IMPUESTO_CIRCULACION|CALCOMANIA|MULTAS|GRAVAMENES, estado: SOLVENTE|PENDIENTE|VIGENTE|VENCIDA|SIN_MULTAS|CON_MULTAS|SIN_GRAVAMENES|CON_GRAVAMENES|NO_VERIFICADO, detalle }`, requiere `area` y `estado`), `tramite_completo` (boolean, default `false`).
- Flujo: el tramitador reporta en lenguaje libre → Claude extrae actualizaciones de hasta 4 áreas → cada una se valida y se inserta como `notificaciones` (`tipo = area`, `mensaje = "ESTADO: detalle"`) → si `tramite_completo`, se marca la orden `TRAMITE_COMPLETO`, se dispara `validarOrden` (QA) y luego `generarCertificado` (siempre, sin condicionar al `servicio`).

### Agente Certificado (`generar_certificado`, en `src/tools.js` — el 3er uso real de tool_choice, dentro de `pdf-generator.js`)
- `input_schema`: `veredicto` (string, requerido), `atencion_inmediata[]` (default `[]`, uno por punto MAL), `observacion[]` (default `[]`, uno por punto REGULAR), `categorias[]` (requerido, uno por cada punto reportado incluyendo BIEN, `categoria` enum de 8 valores en `CATEGORIAS_INSPECCION`), `veredicto_administrativo` (string, opcional).
- Modelo: Haiku (ver sección 6) — clasificación + traducción a lenguaje de cliente, no razonamiento profundo.

Los roles `cliente`, `validator` y `reporter` usan `llamarClaudeAPI` (texto libre, sin tool).

## 6. Model router — modelos y max_tokens reales (`src/model-router.js`)

| Rol           | Tipo de tarea         | Modelo              | max_tokens |
|---------------|------------------------|----------------------|-----------:|
| cliente       | conversacion           | claude-sonnet-4-6    | 1024 |
| mecanico      | extraccion              | claude-sonnet-4-6    | 1024 |
| tramitador    | conversacion            | claude-sonnet-4-6    | 1024 |
| validator     | razonamiento_profundo  | claude-opus-4-8      | 2048 |
| reporter      | razonamiento_profundo  | claude-opus-4-8      | 2048 |
| certificado   | certificado             | claude-haiku-4-5     | 4096 |

(También existe `clasificacion` → `claude-haiku-4-5`, 200 tokens, pero ningún rol actual la usa.)

Pricing (`PRICING_USD_PER_MTOK`, USD por millón de tokens):

| Modelo | input | output | cacheWrite5m | cacheWrite1h | cacheRead |
|---|---:|---:|---:|---:|---:|
| claude-haiku-4-5 | 1.0 | 5.0 | 1.25 | 2.0 | 0.1 |
| claude-sonnet-4-6 | 3.0 | 15.0 | 3.75 | 6.0 | 0.3 |
| claude-opus-4-8 | 5.0 | 25.0 | 6.25 | 10.0 | 0.5 |

Todas las llamadas usan `cache_control: { type: 'ephemeral' }` en el system prompt (cache de 5 minutos).

## 7. Budget tracker — umbrales reales (`src/budget-tracker.js`)

- `BUDGET_LIMIT_USD`: `process.env.BUDGET_LIMIT_USD` o **$150 USD/mes** por defecto.
- `DEGRADE_THRESHOLD = 0.8` (80% del presupuesto mensual).
- `verificarPresupuesto(db)` suma `costo_estimado_usd` desde el inicio del mes (`obtenerGastoDesde`) y devuelve `nivel`:
  - `normal` si `porcentaje < 0.8`
  - `degradado` si `0.8 <= porcentaje < 1`
  - `bloqueado` si `porcentaje >= 1`
- `aplicarDegradacion(modelo, nivel)`: si `bloqueado`, lanza `AppError(402)` antes de llamar a Claude. Si `degradado`, downgrade vía `DOWNGRADE_MAP`: `claude-opus-4-8 → claude-sonnet-4-6`; sonnet y haiku no tienen downgrade (se quedan igual).
- `registrarLlamada(db, { rol, modelo, tipoTarea, usage, placa })`: calcula el costo real con `calcularCostoUSD` (input/output/cache_creation/cache_read) y lo persiste vía `db.registrarCostoAPI`.

## 8. Variables de entorno requeridas

> `.env.example` no es legible en este sandbox (bloqueado por permisos). Esta lista está derivada de `grep -r process.env src/` — son las variables que el código realmente lee.

| Variable | Usado en | Notas |
|---|---|---|
| `ANTHROPIC_API_KEY` | index.js, worker.js, pdf-generator.js | Clave de la API de Claude |
| `ANTHROPIC_API_URL` | claude-client.js | Override solo para tests (apunta a un servidor local mock) |
| `SUPABASE_URL` | db.js | URL del proyecto Supabase |
| `SUPABASE_KEY` | db.js | Debe ser la `service_role` key (RLS sin políticas en varias tablas) |
| `PORT` | index.js | Default `3000` |
| `NODE_ENV` | index.js, middleware.js | Default `development` |
| `PUBLIC_URL` | index.js | Default `http://localhost:3000`, usado para registrar webhooks de Telegram |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | index.js | Verify token del challenge de Meta (`GET /webhook/whatsapp`) |
| `WHATSAPP_APP_SECRET` | index.js, webhook-security.js | HMAC para verificar `X-Hub-Signature-256`; si falta, se deja pasar sin verificar (con warning único) |
| `TELEGRAM_MECANICO_BOT_TOKEN` | index.js, worker.js, telegram-client.js | Bot token del bot mecánico |
| `TELEGRAM_TRAMITADOR_BOT_TOKEN` | index.js, worker.js, telegram-client.js | Bot token del bot tramitador |
| `TELEGRAM_MECANICO_WEBHOOK_SECRET` | index.js | Secret token verificado en `X-Telegram-Bot-Api-Secret-Token` |
| `TELEGRAM_TRAMITADOR_WEBHOOK_SECRET` | index.js | Idem, bot tramitador |
| `TELEGRAM_AUTO_REGISTER_WEBHOOK` | index.js | Solo si es literalmente `'true'` se registra el webhook contra Telegram al arrancar — evita reapuntar producción accidentalmente |
| `DATABASE_TYPE` | index.js | Solo informativo, se imprime en `/` y en logs de arranque; no condiciona ninguna lógica (siempre se usa Supabase) |
| `BUDGET_LIMIT_USD` | budget-tracker.js | Default `150` |
| `QUEUE_CONCURRENCY` | queue.js | Default `10` |
| `QUEUE_POLL_INTERVAL_MS` | queue.js | Default `5000` |

## 9. Comandos de desarrollo

```bash
npm install --legacy-peer-deps   # necesario por conflicto eslint 8 / @eslint/js (ver sección 10)
npm run dev                      # node --watch src/index.js
npm start                        # node src/index.js
npm test                         # node --test tests/*.test.js (59 tests, 8 archivos)
npm run lint                     # eslint src/ --fix
npm run format                   # prettier --write .
npm run test:manual              # bash tests/curl-commands.sh
```

Cobertura real de `tests/` (8 archivos, 59 tests): `budget-tracker`, `claude-client`, `queue`, `errors`, `validators`, `webhook-security`, `model-router`, `processors`. **No existe `tests/pdf-generator.test.js`** — el generador de PDF solo se ha verificado manualmente con scripts ad-hoc (smoke tests), no tiene cobertura automatizada.

## 10. Pendientes conocidos

- **WhatsApp saliente no implementado**: `procesarWhatsapp` genera la respuesta de Claude y la guarda en `conversaciones`, pero nunca la envía de vuelta al cliente (no hay integración con la Graph API de Meta para enviar mensajes, solo se recibe). Hay un `logger.warn` explícito en el código marcando este gap.
- **`src/middleware.js` es código muerto**: define `apiLimiter`, `healthEndpoint` y `requestLogger`, pero `index.js` importa `ratelimit.js` (un archivo distinto y más simple) — `middleware.js` no se importa desde ningún lugar. Limpiar o consolidar.
- **`migrations/004_certificado_pdf.sql` no aplicado en producción**: pendiente de ejecutar manualmente en el SQL Editor de Supabase (sin credenciales en este sandbox).
- **Bucket `certificados` en Supabase Storage no garantizado**: `asegurarBucketCertificados()` lo crea de forma idempotente en el primer certificado generado, pero si falla (por ejemplo por permisos), el sistema cae a guardar el PDF en `/tmp` del proceso — que no persiste entre despliegues/reinicios. Se recomienda crear el bucket manualmente con `scripts/crear-bucket-certificados.js` antes de ir a producción.
- **No hay test automatizado de `pdf-generator.js`**: cualquier cambio al PDF debe verificarse manualmente (ver smoke tests usados durante la sesión de rediseño, no commiteados como suite formal).
- **`DATABASE_TYPE` es solo cosmético**: se lee y se imprime pero no selecciona ningún backend alternativo; todo el código de `db.js` está atado a Supabase.
- **Rate limiting solo en memoria**: `express-rate-limit` sin store distribuido — no es correcto si el backend corre en más de una instancia.

## 11. Reglas para futuras sesiones de Claude Code

1. **No asumas WhatsApp saliente funciona** — cualquier feature que dependa de notificar al cliente por WhatsApp requiere implementar primero el envío vía Graph API; hoy solo se recibe.
2. **`db.js` es la única puerta a Supabase** — no agregues queries de Supabase en otros archivos; añade una función nueva ahí y expórtala en el `export default`.
3. **Los tool schemas viven en `src/tools.js`** — si cambias el comportamiento de un agente con `tool_choice` forzado, el schema y el código que consume su `input` (en `processors.js` o `pdf-generator.js`) deben cambiar juntos; ambos enums (`estado`, `area`, `categoria`) están duplicados como constantes locales en `processors.js`/`pdf-generator.js` para validar el output del modelo — mantenlos sincronizados con `tools.js`.
4. **Toda llamada a Claude debe pasar por `claude-client.js`** (`llamarClaudeAPI` o `llamarClaudeConTool`) — nunca llames a `axios.post` directo a la API de Claude desde otro módulo, porque eso te saltarías la verificación de presupuesto y el registro de costo.
5. **Respeta el patrón ack-then-process** — los webhooks deben responder 200 rápido y encolar (`db.encolarJob`); no agregues lógica de negocio pesada directamente en las rutas de `index.js`.
6. **pdfkit y `doc.x`/`doc.y`**: si usas `.text(str, x, y)` con coordenadas absolutas, `doc.x` queda apuntando a ese `x`. Si después llamas `.text()` sin `x` explícito pero con `width`, puede desbordar el margen derecho de la página (se ve como texto "cortado", no es un truncamiento real de pdfkit). Siempre resetea `doc.x = doc.page.margins.left` al final de cualquier helper que posicione con coordenadas absolutas.
7. **No leas `.env` ni `.env.example` directamente** — está bloqueado por permisos en este entorno; usa `grep -r process.env src/` para inventariar variables reales.
8. **Antes de tocar `pdf-generator.js`**, genera un PDF de prueba con datos ficticios (hay un patrón de smoke test usado en sesiones anteriores: mockear `db` con datos fijos y un servidor HTTP local que responde como la API de Claude) y revísalo visualmente — no hay test automatizado que lo cubra.
9. **No commitees directo a `main`** salvo instrucción explícita del usuario para esa tarea puntual — la rama de desarrollo estándar de este repo es `claude/certimotors-pdf-generator-l73ep0` (o la que el usuario indique en cada sesión).
10. **Antes de un PR con cambios a `package.json`**, verifica que `npm ci` (no solo `npm install --legacy-peer-deps`) no falle por conflictos de peer deps — el CI de GitHub Actions usa `npm ci` estricto.
