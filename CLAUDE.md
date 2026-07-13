# CLAUDE.md — CERTIMOTORS Backend
> Instrucciones maestras para Claude Code (Sonnet 4.6).
> Leer COMPLETO antes de ejecutar cualquier acción.
> Auditoría técnica base: AUDITORIA_TECNICA.md (21 Jun 2026)

---

## 🔐 PERMISOS — Solicitar TODO en un solo bloque al inicio

Antes de tocar cualquier archivo, pedir autorización explícita para:

1. **Git:** commit de archivos untracked, merge de `feature/agentes-mecanico-tramitador` → `main`, push a GitHub
2. **Archivos fuente:** modificar `src/index.js`, `src/db.js`, `src/processors.js`, `src/middleware.js`, `src/validators.js`, `src/errors.js`, `src/ratelimit.js`, `.env.example`, `package.json`
3. **Supabase:** ejecutar migraciones pendientes, crear funciones faltantes (NO eliminar tablas sin confirmación adicional)
4. **Render:** indicar qué variables de entorno agregar/cambiar (el usuario las aplica manualmente)
5. **Limpieza:** eliminar archivos huérfanos (`src/db.jstab`, `src/index.jstab`, `src/index.js.bak`, `index.js` raíz si ya está consolidado)

**Regla de oro:** Acción destructiva = parar y confirmar. Un solo `git revert` debe poder deshacer cualquier sesión.

---

## 📍 CONTEXTO DEL PROYECTO

### ¿Qué es CERTIMOTORS?
Plataforma de certificación vehicular en Guatemala. Tres actores:
- **Cliente:** envía placa por WhatsApp → Claude responde → recibe PDF de certificado
- **Mecánico:** usa bot Telegram para registrar 110 puntos de inspección por placa
- **Tramitador:** usa bot Telegram para gestionar trámites SAT/municipales por placa

### Servicios y precios (Jul 2026)
- **BÁSICO** (código `BASICO`) — Q550
- **FULL** (código `FULL`) — Q1,200

### Estados de `ordenes.status`
```
SERVICIO_PRESENTADO   → orden creada, esperando elección de servicio
ESPERANDO_PAGO        → servicio elegido (BASICO o FULL), link de pago enviado
PAGO_CONFIRMADO       → webhook de Recurrente confirmó el pago
INSPECCION_COMPLETA   → mecánico reportó los 110 puntos
TRAMITE_COMPLETO      → tramitador completó el trámite SAT/municipal
CERTIFICADO_APROBADO  → admin aprobó el certificado PDF
NECESITA_CORRECCION   → admin rechazó; vuelve al tramitador
```
> `ordenes.status` es `VARCHAR(50)`, no enum de Postgres — agregar estados nuevos NO requiere migración.

### Stack
- **Runtime:** Node.js ≥18, ES Modules (`"type": "module"`)
- **Framework:** Express 4.18
- **DB:** Supabase (PostgreSQL) — en producción usa SQLite por error (crítico)
- **IA:** Anthropic Claude API con model router y budget tracker propios
- **Bots:** 2 bots Telegram (mecánico + tramitador) + WhatsApp Cloud API
- **Deploy:** Render.com → `certimotors.onrender.com`, repo `lrgalindo/CERTIMOTORS`

### Rutas locales
```
Proyecto:   ~/Desktop/CERTIMOTORS-repo/
Repo:       https://github.com/lrgalindo/CERTIMOTORS.git
Producción: https://certimotors.onrender.com
```

---

## 🔍 FASE 1 — AUDITORÍA Y DIAGNÓSTICO (sin modificar nada)

### 1.1 Estado exacto del repo
```bash
git status
git log --oneline -10
git branch -a
git stash list
```

### 1.2 Leer TODOS los archivos fuente antes de actuar
```bash
# Entry point real
cat src/index.js

# Módulos no commiteados (crítico — verificar que no están rotos)
cat src/processors.js
cat src/claude-client.js
cat src/telegram-client.js
cat src/worker.js
cat src/queue.js

# DB y esquema
cat src/db.js
cat migrations/init.sql
cat migrations/002_costos_api.sql
cat migrations/003_cola_jobs.sql

# Prompts y lógica
cat src/prompts.js
cat src/model-router.js
cat src/budget-tracker.js
cat src/middleware.js
cat src/validators.js
cat src/errors.js
cat src/ratelimit.js
cat src/logger.js

# Config
cat package.json
cat .env.example
```

### 1.3 Verificar estado de producción
```bash
curl https://certimotors.onrender.com/
curl https://certimotors.onrender.com/health
curl https://certimotors.onrender.com/metrics
```
> ⚠️ Si `"database":"sqlite"` → error crítico P1. Supabase debe ser la DB.
> ⚠️ Si `"model_router":"activo"` → el src/index.js completo está corriendo ✅

### 1.4 Detectar archivos huérfanos
```bash
ls src/
# Buscar: db.jstab, index.jstab, index.js.bak
# Buscar: index.js en raíz del proyecto
ls *.js 2>/dev/null
```

### 1.5 Verificar si migraciones de Supabase están aplicadas
Preguntar al usuario si las migraciones `init.sql`, `002_costos_api.sql`, `003_cola_jobs.sql` fueron ejecutadas en el dashboard de Supabase. No asumir que sí.

> **Jul 2026:** Migraciones `005_servicio_basico.sql` y `006_conversaciones_sin_placa.sql` ya aplicadas en Supabase ✅

### 1.6 Reporte de auditoría al usuario
Antes de modificar NADA, presentar:
- Estado actual vs esperado para cada problema
- Lista priorizada de fixes con estimado de riesgo
- Confirmación del usuario para continuar

---

## 🚨 PROBLEMAS A RESOLVER (basados en AUDITORIA_TECNICA.md + hallazgos actuales)

### P0 — CRÍTICO: SQLite en producción en lugar de Supabase
**Evidencia:** `curl https://certimotors.onrender.com/` → `"database":"sqlite"`
**Causa probable:** Variable `DATABASE_TYPE` incorrecta en Render, o `db.js` tiene fallback a SQLite
**Fix:**
1. Leer `src/db.js` completo para entender el switch de DB
2. Verificar que Render tiene `SUPABASE_URL` y `SUPABASE_KEY` con valores reales
3. Si `db.js` tiene lógica de fallback a SQLite, eliminarla o forzar Supabase
4. Agregar `DATABASE_TYPE=supabase` en Render si lo usa como switch
**Validación:** `curl https://certimotors.onrender.com/` debe mostrar `"database":"supabase"`

---

### P0 — CRÍTICO: Archivos fuente sin commitear
**Evidencia:** `git status` muestra como untracked:
- `src/processors.js`
- `src/claude-client.js`
- `src/telegram-client.js`
- `src/worker.js`
- `src/queue.js`
- `migrations/003_cola_jobs.sql`

**Fix:**
```bash
# Primero verificar sintaxis de cada archivo
node --check src/processors.js
node --check src/claude-client.js
node --check src/telegram-client.js
node --check src/worker.js
node --check src/queue.js

# Si no hay errores de sintaxis:
git add src/processors.js src/claude-client.js src/telegram-client.js \
        src/worker.js src/queue.js migrations/003_cola_jobs.sql
git commit -m "feat: add processors, claude-client, telegram-client, worker, queue modules"
git checkout main
git merge feature/agentes-mecanico-tramitador --no-ff -m "merge: integrate agent modules to main"
git push origin main
```
**Regla:** NO hacer merge si hay errores de sintaxis. Corregir primero en la rama feature.

---

### P0 — CRÍTICO: WhatsApp no envía respuesta al cliente
**Evidencia:** Comentario en `src/processors.js`:
`"envío saliente no implementado"`
**Archivos a modificar:** `src/processors.js` — función `procesarWhatsapp()`
**Fix:** Agregar ÚNICAMENTE el bloque de envío saliente, sin cambiar nada más:
```javascript
// Agregar después de generar respuesta de Claude, antes del return
await axios.post(
  `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
  {
    messaging_product: 'whatsapp',
    to: numeroCliente,
    type: 'text',
    text: { body: respuesta }
  },
  {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }
);
logger.success('Respuesta enviada al cliente por WhatsApp', { numeroCliente });
```

---

### P1 — ALTO: Funciones de DB faltantes en `src/db.js`
**Evidencia:** `src/index.js` llama funciones que no existen en `src/db.js`:
- `obtenerConversacionesPorPlaca(placa)`
- `guardarConversacion(placa, clienteId, tipo, entrada, respuesta)`
- `obtenerRevisionesPorPlaca(placa)`
- `guardarRevision(placa, mecanicoId, punto, respuesta)`

**Fix:** Implementar las 4 funciones en `src/db.js` usando el cliente Supabase existente:
```javascript
// obtenerConversacionesPorPlaca
export async function obtenerConversacionesPorPlaca(placa) {
  const { data, error } = await supabase
    .from('conversaciones')
    .select('*')
    .eq('placa', placa)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw error;
  return data || [];
}

// guardarConversacion
export async function guardarConversacion(placa, clienteId, tipo, mensajeEntrada, respuestaIA) {
  const { error } = await supabase
    .from('conversaciones')
    .insert({ placa, cliente_id: clienteId, tipo_usuario: tipo,
              mensaje_entrada: mensajeEntrada, respuesta_ia: respuestaIA });
  if (error) throw error;
}

// obtenerRevisionesPorPlaca
export async function obtenerRevisionesPorPlaca(placa) {
  const { data, error } = await supabase
    .from('revisiones')
    .select('*')
    .eq('placa', placa)
    .order('punto_actual', { ascending: true });
  if (error) throw error;
  return data || [];
}

// guardarRevision
export async function guardarRevision(placa, mecanicoId, puntoActual, respuesta) {
  const { error } = await supabase
    .from('revisiones')
    .insert({ placa, mecanico_id: String(mecanicoId),
              punto_actual: puntoActual, respuesta });
  if (error) throw error;
}
```
> Verificar que las tablas `conversaciones` y `revisiones` existen en Supabase antes de implementar.

---

### P1 — ALTO: Bug tramitador — búsqueda incorrecta de cliente
**Evidencia:** En `src/index.js` (o `src/processors.js`):
`db.obtenerClientePorNumero(orden.cliente_id)` — pasa UUID donde espera número de teléfono
**Fix:** Crear función `obtenerClientePorId(id)` en `src/db.js`:
```javascript
export async function obtenerClientePorId(id) {
  const { data, error } = await supabase
    .from('clientes').select('*').eq('id', id).single();
  if (error) return null;
  return data;
}
```
Y reemplazar la llamada en el flujo del tramitador:
```javascript
// Cambiar:
const cliente = await db.obtenerClientePorNumero(orden.cliente_id);
// Por:
const cliente = await db.obtenerClientePorId(orden.cliente_id);
```

---

### P1 — ALTO: Rate limiter y error handler no montados
**Evidencia:** `src/middleware.js` tiene implementación completa pero nunca se monta en Express
**Fix:** En `src/index.js`, agregar después de `app.use(express.json())`:
```javascript
import { rateLimiter, requestLogger, errorHandler } from './middleware.js';
app.use(requestLogger);
app.use(rateLimiter);
// Y al final, antes de app.listen:
app.use(errorHandler);
```
> Verificar el import de logger en middleware.js: debe ser `import { logger }` (named), no default.

---

### P2 — MEDIO: Variables de entorno faltantes en Render
Verificar con el usuario que estas variables están en Render con valores reales:
```
WHATSAPP_TOKEN              ✅ subido
WHATSAPP_PHONE_NUMBER_ID    ✅ 1209535848903480
WHATSAPP_WEBHOOK_VERIFY_TOKEN ✅ configurado en Render
WHATSAPP_BUSINESS_ACCOUNT_ID  → agregar: 1501313747964606
WHATSAPP_APP_SECRET           → pendiente (obtener en Meta Developers → Config Básica)
SUPABASE_URL                  → verificar que no sea placeholder
SUPABASE_KEY                  → verificar que no sea placeholder
ANTHROPIC_API_KEY             → verificar que no sea placeholder
PUBLIC_URL                    → https://certimotors.onrender.com
NODE_ENV                      → production
DATABASE_TYPE                 → supabase
TELEGRAM_AUTO_REGISTER_WEBHOOK → true (si webhooks no están registrados)
TELEGRAM_MECANICO_BOT_TOKEN   → configurado en Render (tokens viejos rotados; nunca commitear valores)
TELEGRAM_TRAMITADOR_BOT_TOKEN → configurado en Render (tokens viejos rotados; nunca commitear valores)
TELEGRAM_ADMIN_CHAT_ID        → agregar (ID numérico del chat admin en Telegram)
RECURRENTE_SECRET_KEY         → agregar (clave secreta de API de Recurrente)
RECURRENTE_WEBHOOK_SECRET     → agregar (secreto para verificar webhooks Svix de Recurrente)
```

---

### P2 — MEDIO: Actualizar .env.example
Reemplazar completamente con variables reales del proyecto (sin valores sensibles):
```env
PORT=3000
NODE_ENV=development
ANTHROPIC_API_KEY=sk-ant-api03-REEMPLAZA
SUPABASE_URL=https://REEMPLAZA.supabase.co
SUPABASE_KEY=REEMPLAZA_SERVICE_ROLE_KEY
WHATSAPP_TOKEN=REEMPLAZA
WHATSAPP_PHONE_NUMBER_ID=REEMPLAZA
WHATSAPP_BUSINESS_ACCOUNT_ID=REEMPLAZA
WHATSAPP_APP_SECRET=REEMPLAZA
WHATSAPP_WEBHOOK_VERIFY_TOKEN=REEMPLAZA
TELEGRAM_MECANICO_BOT_TOKEN=REEMPLAZA
TELEGRAM_TRAMITADOR_BOT_TOKEN=REEMPLAZA
TELEGRAM_AUTO_REGISTER_WEBHOOK=false
PUBLIC_URL=https://REEMPLAZA.onrender.com
DATABASE_TYPE=supabase
```

---

### P3 — LIMPIEZA: Archivos y dependencias huérfanas
**Archivos a eliminar** (confirmar antes):
```bash
rm src/db.jstab src/index.jstab src/index.js.bak 2>/dev/null
# index.js raíz — solo eliminar si src/index.js ya tiene toda la lógica
```

**Dependencias a eliminar de package.json** (confirmar antes):
- `sqlite3` — reemplazado por Supabase
- `ws` — WebSockets nunca implementados
- `body-parser` — redundante con `express.json()`
- `winston` — logger casero usado en su lugar

```bash
npm uninstall sqlite3 ws body-parser winston
```

---

### P4 — INVESTIGAR (no construir sin confirmación): PDF al flujo
**Contexto:** Existe un generador de PDF en Python/ReportLab fuera de este repo.
**Tarea:** Solo investigar y reportar:
1. ¿Está deployado como servicio HTTP separado?
2. ¿Tiene endpoint que pueda llamarse con axios?
3. ¿O debe integrarse dentro de este backend Node.js?
**No construir nada.** Presentar hallazgos al usuario para decidir arquitectura.

---

## ✅ LO QUE YA FUNCIONA — NO TOCAR

| Componente | Archivo |
|---|---|
| GET /webhook/whatsapp (verificación Meta) | `src/index.js` |
| POST /webhook/telegram/mecanico | `src/index.js` |
| POST /webhook/telegram/tramitador | `src/index.js` |
| Model router (Haiku/Sonnet/Opus por rol) | `src/model-router.js` |
| Budget tracker con degradación automática | `src/budget-tracker.js` |
| Sistema de prompts por rol (5 prompts) | `src/prompts.js` |
| Logger estructurado | `src/logger.js` |
| Health check y metrics endpoints | `src/index.js` |
| Auto-registro webhook Telegram al arrancar | `src/index.js` |

---

## 🚫 REGLAS ABSOLUTAS

1. **Leer antes de escribir.** Leer el archivo completo antes de modificarlo.
2. **No inventar funciones, tablas ni endpoints** que no existan en el código actual.
3. **No hacer DROP TABLE, DELETE masivo ni TRUNCATE** sin confirmación adicional explícita.
4. **No cambiar los system prompts** de `src/prompts.js` — son lógica de negocio validada.
5. **No cambiar el model-router** — la selección de modelos es intencional por costo.
6. **No modificar Telegram si estás arreglando WhatsApp** — un sistema a la vez.
7. **Commit atómico por problema resuelto** con mensaje descriptivo en inglés.
8. **Verificar con curl** después de cada deploy antes de marcar como resuelto.
9. **Si algo falla en producción:** `git revert HEAD` inmediato + notificar al usuario.
10. **No tocar .env local** para poner valores reales — solo `.env.example` con placeholders.
11. **No alucinares APIs de Meta o Supabase** — si no conoces el endpoint exacto, buscarlo en docs o preguntar.
12. **Si un archivo no commiteado difiere significativamente** de lo que espera el código, mostrar el diff al usuario antes de commitear.

---

## 📋 ORDEN DE EJECUCIÓN

```
Fase 1: Auditoría completa (sin modificar nada)
  → Leer todos los archivos fuente
  → Verificar producción con curl
  → Reporte al usuario + confirmación para continuar

Fase 2: Git — commit y merge
  → Verificar sintaxis de archivos untracked
  → Commit en feature branch
  → Merge a main + push
  → Verificar que Render redeploya correctamente

Fase 3: Fix DB — SQLite → Supabase
  → Diagnosticar causa exacta en db.js
  → Indicar variables a actualizar en Render
  → Verificar migraciones en Supabase
  → Validar con curl

Fase 4: Fix funciones DB faltantes
  → Implementar 4 funciones en src/db.js
  → Commit + push + verificar logs en Render

Fase 5: Fix WhatsApp outbound
  → Editar src/processors.js (solo agregar envío saliente)
  → Commit + push
  → Prueba con mensaje real de WhatsApp

Fase 6: Fix bug tramitador
  → Agregar obtenerClientePorId en db.js
  → Reemplazar llamada en flujo tramitador
  → Commit + push

Fase 7: Montar middleware
  → Conectar rate limiter y error handler en src/index.js
  → Commit + push + verificar que /health sigue respondiendo

Fase 8: Limpieza
  → Eliminar archivos huérfanos
  → Eliminar dependencias no usadas
  → Actualizar .env.example
  → Commit + push

Fase 9: Validación end-to-end
  → Prueba completa WhatsApp cliente
  → Prueba completa Telegram mecánico
  → Prueba completa Telegram tramitador
  → Verificar que datos llegan a Supabase

Fase 10: Mapeo PDF (investigar, no construir)
  → Reportar hallazgos al usuario
```

---

## 🔗 RECURSOS

| Recurso | URL |
|---|---|
| Render dashboard | dashboard.render.com → servicio certimotors |
| Supabase | supabase.com → proyecto `iyijhruwsbyclavnoscy` |
| Meta Developers | developers.facebook.com/apps/26679746048367896 |
| WhatsApp Manager | business.facebook.com → CertiMotors → Cuentas de WhatsApp |
| GitHub | github.com/lrgalindo/CERTIMOTORS |
| Producción | https://certimotors.onrender.com |

---

## 💬 PROTOCOLO DE COMUNICACIÓN

- Después de la auditoría: mostrar tabla resumen de hallazgos antes de actuar
- Antes de cada fase: anunciar qué se va a hacer y en qué archivos
- Después de cada fix: mostrar el diff exacto aplicado + resultado del curl de validación
- Si encuentra algo no documentado aquí: DETENER y consultar antes de actuar
- Al final de cada fase: resumen de estado y confirmación para continuar con la siguiente

---

---

## 🚀 SPRINT CHECKOUT WEB — 12–13 Jul 2026 (COMPLETADO)

### Qué se construyó

| Componente | Archivo(s) | Estado |
|---|---|---|
| Endpoints checkout (`POST /api/ordenes`, `POST /api/pagos/crear-checkout`) | `src/index.js` | ✅ en producción |
| Webhook Recurrente con verificación HMAC-SHA256 Svix | `src/index.js`, `src/webhook-security.js` | ✅ |
| CORS restringido a `certimotors.com` para endpoints checkout | `src/index.js` | ✅ |
| Rate limiting diferenciado: checkout 20 req/15min, general 100/15min | `src/index.js` | ✅ verificado con curl (HTTP 429 en req 21) |
| Notificaciones idempotentes por destinatario (`mecanico_notificado_at` + `tramitador_notificado_at`) | `src/notificaciones.js`, `src/worker.js`, `src/db.js` | ✅ T007FUL aprobado |
| Migración 006 (columnas per-recipient) | `migrations/006_per_recipient_notification.sql` | ✅ aplicada en Supabase |
| Merge con origin/main: procesarLote, reaper huérfanos, pdf-approval, backoffice | múltiples | ✅ |
| Precios actualizados en prompts (Q300/Q550/Q800) | `src/prompts.js` | ✅ |

### Servicios y precios (Jul 2026, ACTUALIZADOS)
- **SCANNER** (código `SCANNER`) — Q300: escaneo electrónico OBD-II + reporte códigos de error
- **ESTÁNDAR** (código `ESTANDAR`) — Q550: inspección completa 110 puntos + certificado PDF
- **FULL** (código `FULL`) — Q800: ESTÁNDAR + verificación legal (impuesto circulación, calcomanía, multas, gravámenes)

> ⚠️ El CLAUDE.md anterior listaba BÁSICO/FULL con precios Q550/Q1200 — esos precios están desactualizados. Los correctos son los de arriba.

### Tokens de Telegram post-sprint (estado al 13 Jul 2026)

- `TELEGRAM_MECANICO_BOT_TOKEN` → `@certimotors_mecanico_bot` (ID 8921768773) — válido ✅
- `TELEGRAM_TRAMITADOR_BOT_TOKEN` → mismo token que mecánico (duplicado **intencional** hasta obtener bot real)
- `TELEGRAM_MECANICO_CHAT_ID` → chat real del mecánico
- `TELEGRAM_TRAMITADOR_CHAT_ID` → 8289807493 (chat de Rodrigo, **placeholder** hasta tener el chat_id real del tramitador)

### Bug conocido: webhook Telegram del mecánico apunta a endpoint tramitador

**Causa:** Ambos tokens son el mismo bot. `TELEGRAM_AUTO_REGISTER_WEBHOOK=true` en Render llama a `setWebhook` primero con URL `/mecanico`, luego con URL `/tramitador`. La segunda llamada sobreescribe la primera → mensajes entrantes del mecánico llegan al procesador del tramitador.

**Impacto:** Notificaciones **salientes** (checkout web) ✅ no afectadas. Conversaciones **entrantes** del mecánico ❌ rotas.

**Fix definitivo:** Obtener token real y separado para el bot tramitador → poner en `TELEGRAM_TRAMITADOR_BOT_TOKEN` de Render. Después de eso, los dos `setWebhook` registran bots distintos sin conflicto.

**Workaround temporal:** Mientras haya un solo token, desactivar `TELEGRAM_AUTO_REGISTER_WEBHOOK` en Render y registrar solo el webhook del mecánico manualmente vía BotFather o llamada directa a la API.

### Pendientes para próxima sesión

1. **Token real tramitador** — obtener de BotFather, crear bot nuevo separado. Actualizar `TELEGRAM_TRAMITADOR_BOT_TOKEN` y `TELEGRAM_TRAMITADOR_CHAT_ID` en Render.
2. **Chat ID real tramitador** — la persona que tramita necesita iniciar conversación con el bot tramitador y extraer su chat_id. Hoy es 8289807493 (Rodrigo).
3. **Limpieza de órdenes de prueba en Supabase** — T001CFG through T007FUL y Q001QAA–Q003QAC. Mostrar SQL exacto antes de ejecutar.
4. **Frontend web** (`certimotors-web` repo, rama `redesign/v2-home`) — formulario de checkout, flujo de pago. No iniciado.
5. **SEO/Google** (spec Section 13) — GA4, Search Console, sitemap.xml, robots.txt, meta tags, schema.org, NAP.
6. **CLAUDE.md** de `certimotors-web` — crear equivalente para ese repo.
7. **PR #16 hotfix** — merge pendiente de aprobación (fix SyntaxError que impedía deploy del código de checkout).

### Hotfix PR #16 (merge pendiente)

Luego del merge de PR #15, quedaron en `main` dos artefactos del merge que causaban `SyntaxError` al arrancar (`import axios` duplicado, `verificarFirmaRecurrente` duplicado, handler `/webhook/recurrente` duplicado). Render mantuvo el build anterior. El PR #16 (`hotfix/merge-artifacts-jul13`) corrige esto — mergear para que el código de checkout llegue realmente a producción.

---

*Generado para Claude Code — CERTIMOTORS v1.0 — Julio 2026*
*Basado en AUDITORIA_TECNICA.md (21 Jun 2026) + diagnóstico de sesión 29 Jun 2026*
*Actualizado en bloque 4 (QA/cierre documental) — 5 Jul 2026*
*Actualizado tras sprint checkout web — 13 Jul 2026*
