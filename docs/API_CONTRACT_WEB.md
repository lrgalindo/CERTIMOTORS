# Contrato de API para el checkout web — documentación, no implementación

Fuente de verdad: el prototipo de Claude Design (`CERTIMOTORS - sitio completo.html`,
8 Jul 2026) — checkout de 3 pasos (`isStep1/isStep2/isStep3`), pantalla de pago
(`isPago`), certificado de muestra (`isCert`). Este documento define qué necesita
el backend cuando el checkout se conecte. **Nada de esto está implementado.**

Campos extraídos del diseño real — no agregar campos que el diseño no pide.

---

## 1. `POST /api/web/ordenes` — crear orden desde el checkout

Body (los 3 pasos del diseño):

```jsonc
{
  // Paso 1 — contacto
  "nombre": "string, requerido",
  "telefono": "string, requerido — 8 dígitos GT; se normaliza a 502XXXXXXXX",
  "nit": "string, opcional — CF si se omite",

  // Paso 2 — ubicación y vehículo
  "zona": "string, requerido — valor del dropdown del diseño (ver tabla de recargos)",
  "direccion": "string, requerido — dirección exacta donde está el vehículo",
  "placa": "string, requerido — formato A999AAA; reutilizar validatePlaca (src/validators.js)",
  "anio": "integer, requerido",
  "marca": "string, requerido — dropdown del diseño",
  "modelo": "string, requerido",
  "es_dueno": "boolean, requerido — checkbox SIN pre-marcar (decisión anti patrón oscuro)",

  // Paso 3 — confirmación
  "servicio": "\"BASICO\" | \"FULL\"",
  "fecha_tentativa": "string ISO date | null — null = \"no tengo idea aún\" (pickNoIdea)",
  "tipo_documento": "\"factura\" | \"recibo\" — selector del diseño",
  "acepta_terminos": "boolean, requerido true — checkbox SIN pre-marcar"
}
```

Respuesta `201`:

```jsonc
{
  "orden_id": "uuid",
  "placa": "P123ABC",
  "status": "SERVICIO_PRESENTADO",
  "precio_servicio_q": 550,          // fuente de verdad: SERVICIOS en src/processors.js
  "recargo_zona_q": 75,
  "total_q": 625,
  "token_consulta": "hex de un solo cliente — ver endpoint 2"
}
```

Reglas:
- La fecha es **tentativa a confirmar** (mismo modelo operativo que WhatsApp) — la web
  nunca promete hora exacta.
- Reutilizar `db.crearCliente`/`db.crearOrden`; si la placa ya tiene orden de otro
  cliente, `409` sin revelar nada de la orden existente (misma regla que el agente).
- Endpoint público ⇒ pasa por el rate limiter global y valida todo en el borde.

### Recargos por zona (extraídos del diseño — el dropdown es la lista canónica)

| Zona | Recargo Q |
|---|---|
| Mixco, Villa Nueva, Chinautla (y zonas capital) | 0 |
| San Miguel Petapa, Santa Catarina Pinula | 75 |
| Villa Canales, San José Pinula | 100 |
| Amatitlán, Fraijanes | 125 |

---

## 2. `GET /api/web/ordenes/:orden_id?token=...` — estado de la orden (alimenta `isPago`)

Respuesta: `{ placa, status, servicio, total_q, certificado_url? }`.

Seguridad: el `orden_id` UUID no basta como secreto en URLs que se comparten;
exigir el `token_consulta` emitido al crear la orden. Sin token válido → `404`
(no `403`, para no confirmar existencia).

---

## 3. `POST /api/web/ordenes/:orden_id/pago` — iniciar pago

Reutiliza **la integración existente** `crearCheckoutRecurrente(placa, servicio)`
(src/processors.js:180): mismo `metadata: { placa, servicio }`, mismo webhook
`POST /webhook/recurrente` ya firmado/idempotente — **cero código nuevo de pago**,
solo exponer el checkout_url:

```jsonc
{ "checkout_url": "https://app.recurrente.com/..." }
```

Gap: el checkout actual cobra solo el precio del servicio; el recargo de zona
requiere agregar un ítem o ajustar `amount_in_cents` al crear el checkout.

---

## 4. Link de WhatsApp con texto precargado

El sitio arma `wa.me/502XXXXXXXX?text=` — cuando el checkout se conecte, el texto
debe llevar el contexto para que el agente no repregunte:

```
Hola, vengo del sitio. Placa {PLACA}, me interesa el {BASICO|FULL}.
```

El agente ya extrae placa y servicio de texto libre (`extraerPlaca` +
`[SERVICIO:X]`), así que esto funciona hoy sin cambios de backend.

---

## 5. Gaps de esquema (señalados, NO agregados en esta sesión)

| Campo del diseño | ¿Dónde guardarlo? | Estimación |
|---|---|---|
| `zona` + `recargo_zona_q` | `ordenes` — 2 columnas nuevas | migración trivial |
| `direccion` | `ordenes` — 1 columna | trivial |
| `nit` (CF/NIT) | `clientes` — 1 columna | trivial |
| `es_dueno` | `ordenes` — 1 columna boolean | trivial |
| `fecha_tentativa` | `ordenes` — 1 columna date nullable | trivial |
| `tipo_documento` | `ordenes` — 1 columna | trivial |
| `token_consulta` | `ordenes` — 1 columna, o tabla tipo `tokens_aprobacion` | pequeña |

Ya cubiertos por la migración 004: `marca`, `modelo`, `anio`. Precios: el diseño
muestra Q550/Q1,200 — coincide con `SERVICIOS` y con el prompt del agente, sin
inconsistencias. Garantía: mantener el texto de 90 días idéntico al del agente y
del PDF (`Garantía y vigencia`).

## 6. Antipatrones que NO entran (auditoría certifycar)

- Ningún checkbox pre-marcado (ni términos, ni "soy el dueño", ni opt-ins).
- Ningún upsell que cambie el plan elegido sin acción explícita del usuario.
- Cifras de clientes/testimonios consistentes entre secciones.
