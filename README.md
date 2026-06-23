# CERTIMOTORS Backend

Sistema de certificación de vehículos en Guatemala. Tres canales de entrada
(WhatsApp para clientes, Telegram para mecánicos y tramitadores), cinco
agentes de Claude con extracción estructurada vía tool use, y persistencia
en Supabase (PostgreSQL).

## Arquitectura

- **Runtime:** Node.js, Express, ESM (`"type": "module"`)
- **Base de datos:** Supabase (PostgreSQL) vía `@supabase/supabase-js`
- **IA:** Anthropic Messages API, con router de modelos por costo
  (Haiku/Sonnet/Opus según el rol) y degradación automática si se supera
  el 80% del presupuesto mensual (`src/model-router.js`, `src/budget-tracker.js`)
- **Procesamiento:** patrón ack-then-process — los webhooks solo encolan el
  job en `cola_jobs` y responden 200 de inmediato; `src/worker.js` hace
  polling y procesa fuera del ciclo request/response, con reintentos y
  backoff exponencial (`src/queue.js`)

### Agentes (system prompts en `src/prompts.js`)

| Agente | Canal | Rol | Cómo trabaja |
|---|---|---|---|
| Cliente | WhatsApp | `cliente` | Conversacional, guía al cliente por el proceso de certificación |
| Mecánico (Inspector) | Telegram | `mecanico` | Extrae hallazgos de inspección (110 puntos) de lenguaje libre vía tool use; no fuerza turno por turno |
| Tramitador (Coordinator) | Telegram | `tramitador` | Extrae avances del trámite administrativo de lenguaje libre vía tool use; no fuerza etapas fijas |
| Validator | interno (`/api/validar-orden`) | `validator` | QA: aprueba/rechaza una orden para certificación |
| Reporter | interno (`/api/reporte-diario`) | `reporter` | Genera el reporte ejecutivo diario |

El Mecánico y el Tramitador usan `llamarClaudeConTool` (`src/claude-client.js`):
un solo tool forzado por turno que extrae datos estructurados (hallazgos o
avances) y produce el texto de respuesta al humano en la misma llamada.

## Endpoints

- `GET /`, `GET /health`, `GET /metrics` — status y métricas
- `GET /webhook/whatsapp` — verificación del webhook (Meta)
- `POST /webhook/whatsapp` — requiere `X-Hub-Signature-256` válida si
  `WHATSAPP_APP_SECRET` está configurado; encola el mensaje
- `POST /webhook/telegram/mecanico`, `POST /webhook/telegram/tramitador` —
  requieren `X-Telegram-Bot-Api-Secret-Token` válido si el secreto
  correspondiente está configurado; encolan el update
- `POST /api/validar-orden` — `{ placa }` → validación QA + % de inspección
- `POST /api/reporte-diario` — reporte ejecutivo con stats y presupuesto

## Setup

```bash
npm install
cp .env.example .env   # completar con tus credenciales
npm start               # o: npm run dev (con --watch)
```

### Variables de entorno

| Variable | Requerida | Uso |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_KEY` | sí | Conexión a la base de datos (service role key) |
| `ANTHROPIC_API_KEY` | sí | Llamadas a Claude |
| `PORT` | no (default 3000) | Puerto del servidor |
| `PUBLIC_URL` | solo si se auto-registran webhooks | Base URL pública para `setWebhook` |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | sí (canal WhatsApp) | Verificación GET del webhook de Meta |
| `WHATSAPP_APP_SECRET` | recomendada | Verifica `X-Hub-Signature-256`; sin ella, el webhook acepta sin verificar firma (modo dev) |
| `TELEGRAM_MECANICO_BOT_TOKEN`, `TELEGRAM_TRAMITADOR_BOT_TOKEN` | sí (canal Telegram) | Tokens de los bots dedicados |
| `TELEGRAM_MECANICO_WEBHOOK_SECRET`, `TELEGRAM_TRAMITADOR_WEBHOOK_SECRET` | recomendadas | `secret_token` de Telegram; sin ellas, no se verifica el webhook (modo dev) |
| `TELEGRAM_AUTO_REGISTER_WEBHOOK` | no | `true` para llamar `setWebhook` automáticamente al arrancar (ver checkpoint abajo) |
| `BUDGET_LIMIT_USD` | no (default 150) | Tope mensual de gasto en Claude antes de bloquear llamadas |
| `QUEUE_CONCURRENCY` | no (default 10) | Jobs procesados en paralelo por tick del worker |
| `QUEUE_POLL_INTERVAL_MS` | no (default 5000) | Frecuencia de polling de `cola_jobs` |

> ⚠️ `TELEGRAM_AUTO_REGISTER_WEBHOOK=true` reapunta los webhooks de Telegram
> en cada arranque/deploy — solo activarlo cuando se quiera confirmar
> explícitamente ese cambio (no dejarlo prendido por defecto en producción
> sin revisar).

## Base de datos

Migraciones en `migrations/`, a aplicar manualmente en el SQL Editor de
Supabase, en orden:

1. `init.sql` — esquema base (clientes, ordenes, conversaciones, revisiones, notificaciones)
2. `002_costos_api.sql` — tracking de costos de Claude
3. `003_cola_jobs.sql` — cola de jobs para el patrón ack-then-process

## Tests

```bash
npm test
```

Suite con `node:test` (sin dependencias externas). Las llamadas a Claude se
prueban contra un servidor HTTP local que imita la Messages API
(`ANTHROPIC_API_URL` es configurable para esto); las funciones de
`db.js` no tienen tests unitarios porque son wrappers delgados sobre
Supabase — su corrección se verifica con boot tests contra Supabase real.

## Gaps conocidos

- **Envío saliente de WhatsApp:** el agente Cliente genera la respuesta pero
  no hay integración con la Graph API de Meta para enviarla — queda
  loggeada hasta que se implemente el envío saliente.
- **Generación de certificado en PDF:** al completar un trámite
  (`tramite_completo`), se dispara automáticamente la validación QA
  (`validarOrden`) y se registra como notificación, pero no existe un
  generador de PDF real (librería, plantilla, storage) — es una feature
  pendiente, no implementada.
