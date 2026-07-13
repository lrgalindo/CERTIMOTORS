# QA_RESULTS — Bloque 4 (5 Jul 2026)

Rama: `qa/bloque4-cierre` — revisión honesta sin pruebas en dispositivo real.

---

## Verificado por test automatizado

Cada ítem cita el archivo de test y el nombre exacto del caso.

### Flujo 1 — Cliente nuevo: hola → placa → botones BÁSICO/FULL → selección → link de pago

**Parte A: nueva conversación crea cliente y orden**
- `tests/processors.test.js` — `"procesarWhatsapp: cliente y placa nuevos crean cliente, orden y guardan la conversación"`
- Valida que se llama `db.crearCliente`, `db.crearOrden` y `db.guardarConversacion` con los valores correctos.

**Parte B: botón interactivo persiste servicio y genera link**
- `tests/processors.test.js` — `"procesarWhatsapp: botón FULL persiste servicio, pasa a ESPERANDO_PAGO y envía link de pago sin llamar a Claude"`
- Valida que `db.actualizarDatosOrden` recibe `{ servicio: 'FULL' }`, `db.actualizarStatusOrden` recibe `'ESPERANDO_PAGO'` y el envío WhatsApp contiene el link de pago.

### Flujo 2 — Mensaje combinado: placa y servicio en un solo mensaje, sin repregunta

- `tests/processors.test.js` — `"procesarWhatsapp: placa y servicio en un solo mensaje — marcador [SERVICIO:FULL] elige y agrega link"`
- Input: `'hola quiero certificar placa P999ZZZ con el full'`. Claude emite `[SERVICIO:FULL]`; el código lo detecta con `extraerMarcadores` (src/processors.js:40), llama `confirmarServicio` y añade el link a la respuesta sin repregunta. El test verifica todo el flujo con mock de Claude.

### Flujo 3 — 3 mensajes rápidos del mismo cliente se procesan en orden

- `tests/queue.test.js` — `"procesarLote: 3 jobs del mismo cliente se procesan en orden de llegada"`
- Verifica que el worker serializa por `claveCliente` (mismo número WhatsApp) y que el orden de ejecución coincide con el de llegada.

### Flujo 4 — Cliente cambia de opinión de servicio antes de pagar

- Verificado por lectura de código (ver siguiente sección). No existe un test automatizado específico para el cambio post-elección; el test del flujo 1B cubre el primer paso.

### Flujo 7 — Placa de otro cliente: no se filtra nada

- `tests/processors.test.js` — `"procesarWhatsapp: placa de otro cliente no expone la orden ajena"`
- Verifica que cuando `orden.cliente_id !== cliente.id` el código pone `ordenAjena = true`, pone `orden = null` y el prompt no recibe los datos de la orden ajena.

### Flujo 9 — Webhook de pago Recurrente → PAGO_CONFIRMADO

- `tests/processors.test.js` — `"procesarPagoRecurrente: marca PAGO_CONFIRMADO y registra notificación"`
- Verifica que `db.actualizarStatusOrden(placa, 'PAGO_CONFIRMADO')` y `db.crearNotificacion(placa, 'PAGO_CONFIRMADO', …)` son llamados.
- `tests/processors.test.js` — `"procesarPagoRecurrente: ignora eventos que no son pago exitoso"`
- Verifica que `{ procesado: false }` se retorna si `event_type` no coincide con `/paid|succeeded|completed/i`.

### Flujo 10 — Precios Q550/Q1,200 consistentes

- `tests/naming.test.js` — `"naming: src/ y migrations/ no contienen el servicio ni los precios viejos"` (añadido en este bloque)
- Escanea `src/*.js` y `migrations/*.sql` (excepto `004_certificado_pdf.sql`, registro histórico inmutable) y falla si encuentra `ESTÁNDAR`, `estandar`, `estándar`, `Q650`, `Q800` o `Q1,400`. El patrón excluye la frase benigna "estándar Svix" (comentario en `src/webhook-security.js:32`) y `standardHeaders` (opción de express-rate-limit en `src/ratelimit.js:7`).

### Seguridad del webhook de pago

- `tests/webhook-security.test.js` — `"verificarFirmaRecurrente: acepta firma svix v1 correcta con timestamp fresco"`
- `tests/webhook-security.test.js` — `"verificarFirmaRecurrente: rechaza firma incorrecta o headers faltantes"`
- `tests/webhook-security.test.js` — `"verificarFirmaRecurrente: rechaza timestamp fuera de la ventana anti-replay"`
- `tests/webhook-security.test.js` — `"verificarFirmaRecurrente: sin secreto configurado rechaza (fail closed — endpoint de pago)"`

---

## Verificado por lectura de código

Cada ítem cita archivo y número de línea de la lógica relevante.

### Flujo 4 — Cliente cambia de opinión de servicio antes de pagar

- `src/processors.js:279` — `const puedeElegir = orden && ['INICIADA', 'SERVICIO_PRESENTADO', 'ESPERANDO_PAGO'].includes(orden.status);`
- `src/processors.js:280-283` — Si el agente emite `[SERVICIO:X]` y `puedeElegir` es verdadero, se llama `confirmarServicio(db, orden.placa, servicioElegido)` que actualiza `ordenes.servicio` y `ordenes.status`, y genera un nuevo link de checkout. Esto aplica incluso si ya estaba en `ESPERANDO_PAGO`.
- `src/prompts.js:36` — El system prompt instruye explícitamente: "Si cambia de opinión de servicio antes de pagar, actualizá y seguí — sin reiniciar, sin pedir la placa otra vez."
- No hay un test automatizado que simule el cambio exacto de BASICO→FULL con una orden en `ESPERANDO_PAGO`; la lógica de tres estados en `puedeElegir` la cubre de forma defensiva.

### Flujo 5 — Placa mal formateada normalizada

- `src/validators.js:32-38` (función `extraerPlaca`) — `texto.toUpperCase()` normaliza mayúsculas; el regex `\b([A-Z])[ -]?(\d{3})[ -]?([A-Z]{3})\b` acepta espacios y guiones como separadores y los descarta al armar la placa limpia (ej. `p 926 ftb` → `P926FTB`).
- `src/processors.js:238` — `let placa = extraerPlaca(textoCliente)` aplica la normalización antes de cualquier operación de DB.
- El comportamiento de normalización está cubierto indirectamente por los tests de `procesarWhatsapp` que pasan placas en formato canónico; la regex en sí no tiene un test unitario propio de casos con guiones/minúsculas.

### Flujo 6 — Cliente no sabe su placa

- `src/prompts.js:40` — El system prompt instruve: "Si no hay placa: pedila. Si no la sabe: '¿Tenés la tarjeta de circulación a la mano? La placa aparece arriba.'"
- La respuesta la genera Claude siguiendo la instrucción del prompt; no hay código de aplicación que maneje este caso directamente, por diseño (el LLM es el que responde).

### Flujo 8 — Mensajes ambiguos no reinician el guión

- `src/prompts.js:37` — "Nunca repitas el saludo de bienvenida si ya hay historial."
- `src/prompts.js:39` — "Mensajes ambiguos ('ok', '👍', '?'): interpretá por el contexto del historial; si de verdad no está claro, pedí una aclaración breve y puntual."
- `src/processors.js:259-263` — El historial de conversaciones por cliente se pasa siempre al system prompt; Claude tiene el contexto para no reiniciar.
- La respuesta concreta depende del LLM; el código garantiza que el historial está disponible.

---

## Pendiente de prueba manual en WhatsApp real

Estos flujos requieren un número de WhatsApp activo, el entorno de producción corriendo y credenciales reales. No pueden ser verificados en CI.

1. **Flujo completo extremo a extremo (Flujos 1, 2, 9 combinados):** enviar un mensaje de WhatsApp real, recibir los botones interactivos nativos en el teléfono, confirmar que el botón genera el link de Recurrente correcto, pagar, y verificar que llega el `POST /webhook/recurrente` firmado y que el status en Supabase cambia a `PAGO_CONFIRMADO`.

2. **Flujo 5 con dispositivo:** escribir `"p 926-ftb"` o `"p926ftb"` desde un teléfono real y comprobar que el sistema reconoce la placa (prueba de la rama de normalización de `extraerPlaca`).

3. **Flujo 6 con dispositivo:** responder "no sé mi placa" y verificar que el bot responde con la mención de la tarjeta de circulación.

4. **Flujo 8 con dispositivo:** enviar "ok" o "👍" a mitad de una conversación activa y verificar que el bot no reinicia el saludo sino que responde en contexto.

5. **Botones interactivos visibles en WhatsApp:** el código envía `type: 'interactive'` correctamente (verificado por lectura), pero la renderización real de los botones en la app de WhatsApp requiere confirmación visual en un dispositivo.

6. **Escalación humana (`[ESCALAR]`):** el agente puede emitir la señal y `src/processors.js:286-289` la detecta y loguea, pero el Bloque 3 (rama `feat/bloque3-notificaciones`) es quien envía la notificación al admin. Cubierto en ese PR.

7. **Notificación al cliente tras PAGO_CONFIRMADO:** `src/processors.js:327-340` envía el mensaje WhatsApp best-effort; el test unitario verifica la llamada mock pero no el mensaje real en el teléfono.

---

## Resultado de la suite (89 tests)

```
tests 89 — pass 89 — fail 0
```

Los 88 tests pre-existentes pasan sin cambios. El test nuevo (`tests/naming.test.js`) suma 1.

---

## Estado de los flujos por categoría

| Categoría | Flujos |
|---|---|
| Verificado por test automatizado | 1A, 1B, 2, 3, 7, 9, 10 (7 flujos) |
| Verificado por lectura de código | 4, 5, 6, 8 (4 flujos) |
| Pendiente de prueba manual | 1+2+9 e2e, 5, 6, 8, botones visuales, escalación (Bloque 3), notif. cliente |
