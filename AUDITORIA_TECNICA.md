# AUDITORIA TÉCNICA — CERTIMOTORS Backend
**Fecha:** 21 de Junio 2026  
**Auditor:** Claude Sonnet 4.6  
**Rama auditada:** `main` (commit `33a1d87`)

---

## RESUMEN EJECUTIVO

El backend se encuentra en un **estado crítico de inconsistencia**: el servidor que realmente corre en producción (`src/index.js`) tiene únicamente 3 rutas de health-check y cero lógica de negocio. Toda la lógica real (webhooks, Claude API, Telegram, WhatsApp) está en un archivo raíz `index.js` que tiene imports rotos y nunca se ejecuta. El sistema no procesa mensajes en este momento.

---

## 1. ARQUITECTURA GENERAL

### Stack

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js ≥18, ESM (`"type": "module"`) |
| Framework HTTP | Express 4.18 |
| Base de datos | Supabase (PostgreSQL) vía `@supabase/supabase-js` |
| IA | Anthropic API (Claude `claude-opus-4-20250514`) — llamadas HTTP directas vía `axios` |
| Mensajería | WhatsApp Business API (webhook receptor) + Telegram Bot API (webhook bidireccional) |
| Compresión | `compression` (gzip) |
| Rate limiting | `express-rate-limit` (definido pero **no montado**) |
| Logging | Logger casero (`console.log`) + winston instalado pero no usado |
| Despliegue | Docker / Railway (hay `railway.toml` + `Dockerfile`) |

### Estructura de carpetas

```
CERTIMOTORS-repo/
├── index.js              ← App completa con toda la lógica (ROTO — imports inválidos)
├── test-supabase.js      ← Script suelto de prueba de conexión
├── package.json
├── Dockerfile            ← Imagen Docker (apunta a src/index.js)
├── railway.toml          ← Config Railway
├── .env.example          ← Variables de ejemplo (desactualizado)
├── .gitignore
├── .eslintrc.json
├── .prettierrc
│
├── src/
│   ├── index.js          ← ⚠️ ENTRY POINT REAL (corre en prod), solo 3 rutas
│   ├── db.js             ← Cliente Supabase + 5 funciones CRUD
│   ├── prompts.js        ← 5 system prompts para Claude
│   ├── middleware.js      ← Rate limiter + request logger (no montado en ninguna ruta)
│   ├── logger.js         ← Logger stub (console.log wrapeado)
│   ├── errors.js         ← Error handler stub (no montado)
│   ├── ratelimit.js      ← Stub vacío, solo llama next()
│   ├── validators.js     ← Stub vacío, solo llama next()
│   ├── index.js.bak      ← Backup de versión anterior de index.js raíz (sin Telegram webhook auto-register)
│   ├── db.jstab          ← Archivo huérfano (guardado con extensión incorrecta)
│   └── index.jstab       ← Archivo huérfano (guardado con extensión incorrecta)
│
├── migrations/
│   └── init.sql          ← Esquema completo PostgreSQL (ejecutar manualmente en Supabase)
│
├── tests/
│   └── curl-commands.sh  ← Script de prueba manual con curl (no es un test runner real)
│
├── scripts/
│   └── audit.sh          ← Script de auditoría (contenido no examinado)
│
├── docs/
│   └── ROADMAP.md        ← Planificación Fases 7-8 (Managed Agents, Q3-Q4 2026)
│
└── .github/
    └── workflows/
        ├── test.yml      ← CI: lint + format check + timeout 5s npm start
        └── security.yml  ← CI: npm audit
```

---

## 2. TODOS LOS ENDPOINTS

### Endpoints en `src/index.js` (lo que REALMENTE corre en producción)

| Método | Path | Descripción |
|--------|------|-------------|
| `GET` | `/` | Status check. Retorna `{ status, service, version, timestamp }` |
| `GET` | `/health` | Health check. Retorna `{ status, timestamp }` |
| `GET` | `/metrics` | Métricas de proceso. Retorna `{ uptime, timestamp }` — **no incluye stats de DB** |

> **Nota:** `src/index.js` llama `initDB()` al arrancar, por lo que sí valida conexión a Supabase, pero no expone ninguna ruta de negocio.

---

### Endpoints en `index.js` raíz (LÓGICA REAL — actualmente ROTO, no corre)

#### Rutas de sistema

| Método | Path | Descripción | Parámetros |
|--------|------|-------------|-----------|
| `GET` | `/` | Status completo | — |
| `GET` | `/metrics` | Stats de DB + métricas de proceso | — |

**Respuesta `GET /`:**
```json
{
  "status": "✅ VIVO",
  "app": "CERTIMOTORS",
  "version": "1.0.0",
  "env": "production",
  "database": "supabase",
  "model": "claude-opus-4-20250514",
  "timestamp": "...",
  "uptime": 120
}
```

**Respuesta `GET /metrics`:**
```json
{
  "uptime": 120,
  "totalRequests": 45,
  "totalErrors": 2,
  "clientes": 10,
  "ordenes": 8,
  "conversaciones": 32,
  "revisiones": 5
}
```

---

#### Webhooks WhatsApp

| Método | Path | Descripción | Parámetros |
|--------|------|-------------|-----------|
| `GET` | `/webhook/whatsapp` | Verificación del webhook con Meta | Query: `hub.verify_token`, `hub.challenge` |
| `POST` | `/webhook/whatsapp` | Recibe mensajes de clientes, llama Claude, guarda conversación | Body: estructura estándar de Meta Webhooks |

**Body POST `/webhook/whatsapp` (formato Meta):**
```json
{
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{
          "from": "50231234567",
          "text": { "body": "Hola quiero certificar placa P926FTB" }
        }]
      }
    }]
  }]
}
```

**Flujo interno:**
1. Extrae número de teléfono y texto del cliente
2. Intenta extraer placa del texto con regex `[A-Z]\d{3}[A-Z]{3}`
3. Busca o crea cliente en Supabase
4. Si hay placa: busca o crea orden
5. Carga historial de conversación (últimas 3)
6. Llama Claude API con `construirSystemPromptCliente()`
7. Guarda conversación en Supabase
8. Retorna respuesta JSON (⚠️ **NO envía el mensaje de vuelta al cliente vía WhatsApp API**)

**Respuesta:**
```json
{ "status": "ok", "respuesta": "...", "placa": "P926FTB" }
```

---

#### Webhooks Telegram

| Método | Path | Descripción | Parámetros |
|--------|------|-------------|-----------|
| `POST` | `/webhook/telegram` | Recibe mensajes de Telegram Bot API, llama Claude, envía respuesta back | Body: objeto `message` de Telegram |
| `POST` | `/webhook/telegram/mecanico` | Endpoint para mecánicos en la app de inspección | Body: `{ message, telegram_id, placa, punto_actual }` |
| `POST` | `/webhook/telegram/tramitador` | Endpoint para coordinadores/tramitadores | Body: `{ message, telegram_id, placa, etapa }` |

**Body POST `/webhook/telegram` (formato Telegram Bot API):**
```json
{
  "message": {
    "chat": { "id": 123456789 },
    "from": { "id": 987654321, "first_name": "Juan" },
    "text": "Revisando motor placa P926FTB"
  }
}
```

**Body POST `/webhook/telegram/mecanico`:**
```json
{
  "message": "El motor está en buen estado",
  "telegram_id": 123456789,
  "placa": "P926FTB",
  "punto_actual": 1
}
```

**Body POST `/webhook/telegram/tramitador`:**
```json
{
  "message": "Los documentos están listos",
  "telegram_id": 123456789,
  "placa": "P926FTB",
  "etapa": "Documentación"
}
```

---

#### API de negocio

| Método | Path | Descripción | Parámetros |
|--------|------|-------------|-----------|
| `POST` | `/api/validar-orden` | Valida estado de una orden (Claude evalúa % completado) | Body: `{ placa: "P926FTB" }` |
| `POST` | `/api/reporte-diario` | Genera reporte ejecutivo diario vía Claude | Sin body |

**Respuesta `/api/validar-orden`:**
```json
{
  "status": "ok",
  "placa": "P926FTB",
  "porcentaje_completado": 35,
  "puntos_completados": 38,
  "validacion": "⚠️ INCOMPLETO - Falta: Puntos 39-110..."
}
```

**Respuesta `/api/reporte-diario`:**
```json
{
  "status": "ok",
  "timestamp": "...",
  "estadisticas": { "clientes": 10, "ordenes": 8, "conversaciones": 32, "revisiones": 5 },
  "reporte": "Reporte ejecutivo generado por Claude..."
}
```

---

## 3. INTEGRACIONES EXTERNAS

### 3.1 Supabase (PostgreSQL)

| Item | Detalle |
|------|---------|
| Package | `@supabase/supabase-js ^2.106.0` |
| Inicialización | `src/db.js` línea 4: `createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)` |
| Variables de entorno | `SUPABASE_URL`, `SUPABASE_KEY` |
| Archivos que la invocan | `src/db.js`, `test-supabase.js` |
| Validación de conexión | `initDB()` hace un `SELECT id FROM clientes LIMIT 1` al arrancar |

**Funciones CRUD implementadas en `src/db.js`:**

| Función | Tabla | Operación |
|---------|-------|-----------|
| `initDB()` | `clientes` | SELECT (test de conexión) |
| `crearCliente(numero, data)` | `clientes` | INSERT |
| `obtenerClientePorNumero(numero)` | `clientes` | SELECT WHERE |
| `crearOrden(placa, data)` | `ordenes` | INSERT |
| `obtenerOrdenPorPlaca(placa)` | `ordenes` | SELECT WHERE |
| `obtenerEstadisticas()` | `clientes`, `ordenes`, `conversaciones`, `revisiones` | COUNT x4 |

⚠️ **Funciones llamadas en `index.js` pero NO implementadas en `src/db.js`:**
- `obtenerConversacionesPorPlaca(placa)` — faltante
- `guardarConversacion(placa, clienteId, tipo, entrada, respuesta)` — faltante
- `obtenerRevisionesPorPlaca(placa)` — faltante
- `guardarRevision(placa, mecanicoId, punto, respuesta)` — faltante

---

### 3.2 Anthropic API (Claude)

| Item | Detalle |
|------|---------|
| Integración | HTTP directo vía `axios` (no hay SDK de Anthropic instalado) |
| Endpoint | `https://api.anthropic.com/v1/messages` |
| Modelo | `claude-opus-4-20250514` (configurable vía env) |
| Variables de entorno | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| Archivos | `index.js` raíz — función `llamarClaudeAPI()` línea 35 |
| Parámetros | `max_tokens: 1500`, `anthropic-version: 2023-06-01` |
| System prompts | `src/prompts.js` — 5 prompts: `Cliente`, `Mecanico`, `Tramitador`, `Validator`, `Reporter` |

La función `llamarClaudeAPI(systemPrompt, messages)` es la única abstracción sobre la API; todos los endpoints la llaman directamente.

---

### 3.3 Telegram Bot API

| Item | Detalle |
|------|---------|
| Integración | HTTP directo vía `axios` |
| Variables de entorno | `TELEGRAM_BOT_TOKEN`, `PUBLIC_URL` |
| Archivos | `index.js` raíz — líneas 167-231, 385-403 |
| Auto-registro | Al arrancar, si existen `TELEGRAM_BOT_TOKEN` y `PUBLIC_URL`, registra automáticamente `PUBLIC_URL/webhook/telegram` en Telegram API |
| Envío de mensajes | `POST https://api.telegram.org/bot{TOKEN}/sendMessage` con `parse_mode: 'HTML'` |

---

### 3.4 WhatsApp Business API (Meta)

| Item | Detalle |
|------|---------|
| Integración | Solo recepción de webhooks (webhook inbound) |
| Variables de entorno | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` |
| Archivos | `index.js` raíz — líneas 94-164 |
| Capacidad de envío | **NO implementada** — el bot recibe mensajes y responde JSON al webhook de Meta, pero no llama la API de WhatsApp para enviar mensajes de vuelta al cliente |

---

### 3.5 Stripe — NO ACTIVA

| Item | Detalle |
|------|---------|
| Mencionado en | `.env.example` (`STRIPE_KEY`) |
| Código existente | **Ninguno** — no hay ningún import ni llamada a Stripe en todo el proyecto |
| Status | Placeholder futuro |

---

### 3.6 Airtable — NO ACTIVA

| Item | Detalle |
|------|---------|
| Mencionado en | `README.md` ("Airtable integrado con 9 CRUD functions"), `.env.example` (`AIRTABLE_BASE`, `AIRTABLE_KEY`) |
| Código existente | **Ninguno** — no está en `package.json`, no hay ningún import |
| Status | Fue eliminado/reemplazado por Supabase, README desactualizado |

---

## 4. MODELO DE DATOS

### Tablas Supabase (definidas en `migrations/init.sql`)

#### `clientes`
```sql
id               UUID PRIMARY KEY DEFAULT uuid_generate_v4()
numero_telefono  VARCHAR(20) UNIQUE NOT NULL
nombre           VARCHAR(255)
tipo             VARCHAR(50)          -- 'CLIENTE', etc.
created_at       TIMESTAMP DEFAULT NOW()
updated_at       TIMESTAMP DEFAULT NOW()
```

#### `ordenes`
```sql
id          UUID PRIMARY KEY DEFAULT uuid_generate_v4()
placa       VARCHAR(10) UNIQUE NOT NULL
cliente_id  UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE
tipo_auto   VARCHAR(100)                -- 'RODADO', etc.
status      VARCHAR(50) DEFAULT 'INICIADA'
created_at  TIMESTAMP DEFAULT NOW()
updated_at  TIMESTAMP DEFAULT NOW()
```

#### `conversaciones`
```sql
id              UUID PRIMARY KEY DEFAULT uuid_generate_v4()
placa           VARCHAR(10) NOT NULL REFERENCES ordenes(placa) ON DELETE CASCADE
cliente_id      UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE
tipo_usuario    VARCHAR(50)
mensaje_entrada TEXT
respuesta_ia    TEXT
tokens_usados   INTEGER
created_at      TIMESTAMP DEFAULT NOW()
```

#### `revisiones`
```sql
id          UUID PRIMARY KEY DEFAULT uuid_generate_v4()
placa       VARCHAR(10) NOT NULL REFERENCES ordenes(placa) ON DELETE CASCADE
mecanico_id VARCHAR(50)
punto_actual INTEGER
respuesta   TEXT
created_at  TIMESTAMP DEFAULT NOW()
```

#### `notificaciones`
```sql
id         UUID PRIMARY KEY DEFAULT uuid_generate_v4()
placa      VARCHAR(10) NOT NULL REFERENCES ordenes(placa) ON DELETE CASCADE
tipo       VARCHAR(100)
mensaje    TEXT
enviado    BOOLEAN DEFAULT false
created_at TIMESTAMP DEFAULT NOW()
```

### Vistas SQL definidas

| Vista | Propósito |
|-------|-----------|
| `orden_completa` | JOIN de ordenes + clientes + conteos de revisiones y conversaciones |
| `estadisticas_diarias` | Agregación diaria: órdenes, clientes, puntos inspeccionados por fecha |

### Índices
```sql
idx_ordenes_placa        ON ordenes(placa)
idx_ordenes_cliente      ON ordenes(cliente_id)
idx_conversaciones_placa ON conversaciones(placa)
idx_revisiones_placa     ON revisiones(placa)
idx_notificaciones_placa ON notificaciones(placa)
idx_clientes_telefono    ON clientes(numero_telefono)
```

### RLS (Row Level Security)
Habilitado en `clientes`, `ordenes`, `conversaciones` con política `allow_all` (permite todo sin restricciones). Apropiado para desarrollo, **inseguro para producción real**.

### Estado de migraciones
Solo existe un archivo `migrations/init.sql`. No hay runner de migraciones — debe ejecutarse manualmente en el SQL Editor de Supabase. El Dockerfile copia la carpeta `migrations/` pero no la ejecuta.

---

## 5. VARIABLES DE ENTORNO

### Variables requeridas para funcionar

| Variable | Usado en | Status en prod |
|----------|----------|---------------|
| `PORT` | `src/index.js`, `index.js` | Activa (default 3000) |
| `SUPABASE_URL` | `src/db.js`, `test-supabase.js` | Activa |
| `SUPABASE_KEY` | `src/db.js`, `test-supabase.js` | Activa |
| `ANTHROPIC_API_KEY` | `index.js` (raíz) | Configurada pero **no usada** en el server real (`src/index.js`) |
| `ANTHROPIC_MODEL` | `index.js` (raíz) | Default: `claude-opus-4-20250514` |
| `TELEGRAM_BOT_TOKEN` | `index.js` (raíz) | Configurada pero **no usada** en el server real |
| `PUBLIC_URL` | `index.js` (raíz) para auto-registro de webhook Telegram | Configurada pero **no usada** en el server real |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | `index.js` (raíz) | Configurada pero **no usada** en el server real |
| `NODE_ENV` | Ambos index.js | Activa (`production`) |
| `DATABASE_TYPE` | `index.js` (raíz) — solo logs | Sin valor definido en .env.example |

### Variables placeholder / no usadas en código

| Variable | Dónde aparece | Status |
|----------|--------------|--------|
| `STRIPE_KEY` | `.env.example` | Sin código — placeholder futuro |
| `AIRTABLE_BASE` | `.env.example` | Sin código — integración eliminada |
| `AIRTABLE_KEY` | `.env.example` | Sin código — integración eliminada |

### Nota sobre Render vs Railway
El `README_PROD.md` está vacío y el `railway.toml` sugiere despliegue en **Railway**, no en Render. Si el deploy actual es en Render, `railway.toml` es irrelevante. Si es en Railway, las variables de entorno se configuran en el dashboard de Railway.

---

## 6. FLUJOS DE NEGOCIO PRINCIPALES

### Flujo 1: Certificación de vehículo vía WhatsApp (cliente)
```
Cliente WhatsApp → POST /webhook/whatsapp
  → Extraer placa del texto (regex)
  → Buscar/crear cliente en Supabase
  → Buscar/crear orden en Supabase
  → Cargar historial conversación (últimas 3 entradas)
  → Llamar Claude API con SystemPrompt "Cliente"
  → Guardar conversación en Supabase
  → Retornar respuesta JSON (⚠️ no reenvía al cliente por WhatsApp)
```

### Flujo 2: Inspección mecánica vía Telegram (mecánico)
```
Mecánico Telegram → POST /webhook/telegram (mensaje libre)
  → Extraer placa del texto
  → Obtener revisiones existentes → calcular punto_actual
  → Llamar Claude API con SystemPrompt "Mecánico" (protocolo 110 puntos)
  → Guardar revisión en Supabase
  → Enviar respuesta de vuelta al mecánico vía Telegram sendMessage
```
O via endpoint especializado:
```
POST /webhook/telegram/mecanico (body estructurado)
  → Buscar orden
  → Llamar Claude API con SystemPrompt "Mecánico"
  → Guardar revisión
  → Retornar respuesta JSON (sin enviar a Telegram)
```

### Flujo 3: Coordinación administrativa (tramitador)
```
POST /webhook/telegram/tramitador
  → Buscar orden por placa
  → Buscar cliente (⚠️ bug: pasa cliente_id en lugar de número de teléfono)
  → Llamar Claude API con SystemPrompt "Tramitador"
  → Retornar respuesta JSON
```

### Flujo 4: Validación de orden
```
POST /api/validar-orden { placa }
  → Buscar orden
  → Contar revisiones completadas
  → Calcular porcentaje (revisiones / 110)
  → Llamar Claude API con SystemPrompt "Validator"
  → Retornar evaluación de Claude
```

### Flujo 5: Reporte diario
```
POST /api/reporte-diario
  → Obtener estadísticas globales de Supabase (4 COUNT queries)
  → Llamar Claude API con SystemPrompt "Reporter"
  → Retornar reporte ejecutivo generado por Claude
```

### Flujo 6: Auto-registro de webhook Telegram al arrancar
```
Startup index.js (raíz)
  → Si TELEGRAM_BOT_TOKEN && PUBLIC_URL:
    → POST https://api.telegram.org/bot{TOKEN}/setWebhook
    → body: { url: "{PUBLIC_URL}/webhook/telegram" }
```

### Jobs/Cron
**No existen** jobs automatizados ni cron tasks en el código actual. El reporte diario se genera solo al llamar `POST /api/reporte-diario` manualmente.

---

## 7. DEPENDENCIAS

### Producción (`dependencies`)

| Package | Versión | Para qué se usa | ¿Realmente usada? |
|---------|---------|-----------------|-------------------|
| `@supabase/supabase-js` | ^2.106.0 | Cliente de Supabase/PostgreSQL | ✅ Sí, en `src/db.js` |
| `axios` | ^1.6.0 | HTTP client para Anthropic API y Telegram API | ✅ Sí, en `index.js` raíz |
| `body-parser` | ^1.20.2 | Parsear JSON en requests | ❌ No usada — se usa `express.json()` integrado |
| `compression` | ^1.7.4 | Middleware gzip | ✅ Sí, montado en `index.js` raíz |
| `dotenv` | ^16.3.1 | Cargar variables de entorno desde `.env` | ✅ Sí |
| `express` | ^4.18.2 | Framework HTTP | ✅ Sí |
| `express-rate-limit` | ^8.5.2 | Rate limiting | ⚠️ Definido en `src/middleware.js` pero **no montado en ninguna ruta** |
| `sqlite3` | ^5.1.6 | Base de datos SQLite local | ❌ No usada — reemplazada por Supabase |
| `uuid` | ^9.0.1 | Generar UUIDs para IDs en Supabase | ✅ Sí, en `src/db.js` |
| `winston` | ^3.19.0 | Logger estructurado | ❌ No usada — se usa logger casero en `src/logger.js` |
| `ws` | ^8.20.1 | WebSockets | ❌ No usada — ningún código WebSocket existe |

### Desarrollo (`devDependencies`)

| Package | Versión | Para qué se usa |
|---------|---------|-----------------|
| `@eslint/js` | ^10.0.1 | Reglas ESLint |
| `eslint` | ^8.54.0 | Linting de código |
| `eslint-config-prettier` | ^9.0.0 | Integración ESLint + Prettier |
| `prettier` | ^3.1.0 | Formateado de código |

---

## 8. DEUDA TÉCNICA Y PROBLEMAS DETECTADOS

### Críticos (el sistema no funciona correctamente)

#### CT-1: Bifurcación fatal de entry points
- **Problema:** Existen DOS archivos de entrada: `src/index.js` (lo que corre) y `index.js` raíz (la lógica real). El `package.json` apunta a `src/index.js`, que es solo un health-check sin negocio.
- **Impacto:** Ningún webhook, ninguna llamada a Claude, ninguna lógica de certificación está activa en producción.
- **Fix:** Mover toda la lógica de `index.js` raíz a `src/index.js` (corrigiendo las rutas de import).

#### CT-2: Imports rotos en `index.js` raíz
- **Problema:** `index.js` raíz hace `import * as db from './db.js'` y `import { prompts } from './prompts.js'`, pero estos archivos están en `src/`, no en la raíz.
- **Impacto:** `index.js` raíz crashea inmediatamente si se ejecuta con `node index.js`.
- **Fix:** Corregir rutas a `'./src/db.js'` y `'./src/prompts.js'`, o consolidar en `src/`.

#### CT-3: Funciones de BD faltantes
- **Problema:** `index.js` raíz llama a `db.obtenerConversacionesPorPlaca()`, `db.guardarConversacion()`, `db.obtenerRevisionesPorPlaca()`, y `db.guardarRevision()`. Ninguna está implementada en `src/db.js`.
- **Impacto:** Crashes en runtime en los flujos de WhatsApp y Telegram.
- **Fix:** Implementar las 4 funciones en `src/db.js`.

#### CT-4: WhatsApp no envía mensajes de vuelta
- **Problema:** El webhook POST `/webhook/whatsapp` recibe mensajes y genera respuestas de Claude, pero nunca llama la API de WhatsApp para enviarlas al cliente. Solo retorna JSON.
- **Impacto:** El cliente no recibe ninguna respuesta en WhatsApp.
- **Fix:** Integrar `POST https://graph.facebook.com/v17.0/{PHONE_NUMBER_ID}/messages` con el token de acceso.

### Altos (bugs de lógica)

#### AT-1: Bug en tramitador — búsqueda incorrecta de cliente
- **Problema:** En `POST /webhook/telegram/tramitador`, se llama `db.obtenerClientePorNumero(orden.cliente_id)`. La función `obtenerClientePorNumero` busca por `numero_telefono`, pero se le pasa un UUID (`cliente_id`).
- **Impacto:** Siempre retorna `null` para el cliente en el flujo del tramitador.
- **File:** `index.js` línea 285
- **Fix:** Buscar por ID: `supabase.from('clientes').select('*').eq('id', orden.cliente_id).single()`

#### AT-2: Importación incorrecta del logger
- **Problema:** `src/middleware.js` importa `import logger from './logger.js'` (default import), pero `src/logger.js` usa `export const logger = ...` (named export). 
- **Impacto:** Runtime error si se monta `middleware.js`. `logger` sería `undefined`.
- **Fix:** Cambiar a `import { logger } from './logger.js'`.

#### AT-3: Regex de placa incompleta
- **Problema:** `extraerPlaca()` usa `/[A-Z]\d{3}[A-Z]{3}/`. Las placas guatemaltecas tienen múltiples formatos (ej. `M-123ABC`, `P 926 FTB`, `123-ABC`). La regex actual requiere exactamente 1 letra + 3 dígitos + 3 letras, sin guiones ni espacios.
- **Impacto:** Muchas placas válidas no serán detectadas del texto.
- **Fix:** Ampliar regex para cubrir formatos reales guatemaltecos.

### Medios (código muerto o inconsistencias)

#### MT-1: `src/middleware.js` implementa rate limiting pero no está montado
- El rate limiter de `src/middleware.js` (100 req/15 min, con skip en `/health`) nunca se aplica a ninguna ruta. `src/ratelimit.js` es un stub vacío. Los endpoints están desprotegidos.

#### MT-2: Archivos stub que no hacen nada
- `src/ratelimit.js` — solo llama `next()` 
- `src/validators.js` — solo llama `next()`
- `src/errors.js` — error handler que nunca se monta con `app.use(errorHandler)`

#### MT-3: Dependencias instaladas sin uso
- `body-parser`, `sqlite3`, `ws`, `winston` — 4 paquetes innecesarios aumentan el bundle y la superficie de ataque.

#### MT-4: Archivos huérfanos en `src/`
- `src/db.jstab` — versión del `db.js` con comentario diferente, no referenciada
- `src/index.jstab` — versión del `index.js` con variantes, no referenciada
- `src/index.js.bak` — backup de versión anterior sin auto-registro de Telegram

#### MT-5: `test-supabase.js` imprime la URL de Supabase en consola
- Línea 14: `console.log('URL:', process.env.SUPABASE_URL)` — filtra información de infraestructura a logs.

#### MT-6: Sin autenticación en los endpoints de API
- `POST /api/validar-orden` y `POST /api/reporte-diario` no tienen ninguna autenticación. Cualquiera puede llamarlos y generar llamadas costosas a Claude API.

#### MT-7: Métricas de requests incompletas
- `METRICS.totalRequests++` solo se incrementa en los endpoints de webhook (WhatsApp, Telegram), no en `/api/validar-orden` ni `/api/reporte-diario`.

#### MT-8: No hay manejo de señales de proceso
- Sin `process.on('SIGTERM', ...)` ni `process.on('SIGINT', ...)` para graceful shutdown.

#### MT-9: Sin SDK de Anthropic
- Se llama la API de Anthropic manualmente con axios en lugar de usar `@anthropic-ai/sdk`. Esto omite reintentos automáticos, streaming, y tipado.

#### MT-10: `.env.example` desactualizado
- Falta `SUPABASE_URL`, `SUPABASE_KEY`, `TELEGRAM_BOT_TOKEN`, `PUBLIC_URL`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `ANTHROPIC_MODEL`, `NODE_ENV`.
- Tiene `AIRTABLE_BASE`, `AIRTABLE_KEY`, `STRIPE_KEY` que no se usan.

#### MT-11: README.md desactualizado
- Dice "Airtable integrado (9 CRUD functions)" — Airtable no existe en el código.
- Apunta a `node index.js` como comando de inicio, pero el comando real es `node src/index.js`.

#### MT-12: RLS de Supabase en modo `allow_all`
- Las políticas de Row Level Security permiten todo sin restricciones (`USING (true)`). Funcional para desarrollo, pero en producción real todos los datos estarían accesibles sin autenticación desde el lado del cliente de Supabase.

#### MT-13: No existe suite de tests real
- `npm test` ejecuta `bash tests/curl-commands.sh`, que es un script de curl manual. No hay Jest, Vitest ni ningún framework de tests. El CI intenta arrancar el servidor 5 segundos y considera eso como "test".

#### MT-14: `compression` montado con `index.js` raíz pero no en `src/index.js`
- El server real en producción no tiene compresión gzip activa.

---

## RESUMEN DE PRIORIDADES

| Prioridad | Item | Esfuerzo |
|-----------|------|---------|
| 🔴 P0 | Consolidar entry points: mover lógica de `index.js` raíz a `src/index.js` | Alto |
| 🔴 P0 | Implementar 4 funciones BD faltantes en `src/db.js` | Medio |
| 🔴 P0 | Implementar envío de mensajes WhatsApp de vuelta al cliente | Medio |
| 🟠 P1 | Corregir bug tramitador (buscar cliente por ID, no por teléfono) | Bajo |
| 🟠 P1 | Montar rate limiter y error handler de `src/middleware.js` | Bajo |
| 🟠 P1 | Añadir autenticación a `/api/*` endpoints | Medio |
| 🟡 P2 | Actualizar `.env.example` con todas las variables reales | Bajo |
| 🟡 P2 | Eliminar dependencias no usadas (`sqlite3`, `ws`, `body-parser`, `winston`) | Bajo |
| 🟡 P2 | Borrar archivos huérfanos (`*.jstab`, `*.bak`) | Bajo |
| 🟡 P2 | Ampliar regex de placa guatemalteca | Bajo |
| 🟢 P3 | Migrar a `@anthropic-ai/sdk` | Medio |
| 🟢 P3 | Implementar suite de tests real (Jest/Vitest) | Alto |
| 🟢 P3 | Implementar graceful shutdown | Bajo |
