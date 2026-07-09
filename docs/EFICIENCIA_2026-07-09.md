# Eficiencia y limpieza — 9 Jul 2026

Datos reales de `costos_api` y `cola_jobs` en producción (consultados en esta sesión).

## Hallazgo principal: el spam costó $6.77 en un día — el bloqueo funciona

- El número `+1 918 309 2130` envió **926 mensajes** (de 943 conversaciones totales);
  el 8 Jul generó **918 llamadas a Claude = $6.77**.
- Su último mensaje: 8 Jul 23:15 UTC. El PR #13 (`NUMEROS_BLOQUEADOS`) se mergeó
  23:22 UTC. **Cero mensajes suyos desde entonces** — el bloqueo está activo y
  efectivo (verificado en `conversaciones`).
- Gasto total histórico del rol cliente: $6.95 en 943 llamadas — es decir, ~97%
  del gasto fue spam, no clientes.

**Automatización recomendada (documentada, no construida):** tope diario de
mensajes por número (p.ej. 40/día) antes de llamar a Claude — corta al próximo
spammer sin esperar deploy de env var. Una consulta count sobre `conversaciones`
por `cliente_id` + fecha, en `procesarWhatsapp`, antes de `llamarClaudeAPI`.

## Caché de prompt: casi no pega (ahorro real disponible)

En las 918 llamadas del 8 Jul: `cache_creation` promedio 1,703 tokens por llamada
vs `cache_read` promedio 158. El system prompt del cliente lleva el **historial y
el estado embebidos**, así que cambia en cada mensaje y el caché se re-escribe
(tarifa 1.25x) en vez de leerse (tarifa 0.1x).

**Recomendación:** partir el prompt en dos bloques de system: el briefing estático
(identidad, datos duros, reglas — ~80% del texto) con `cache_control`, y el
contexto dinámico (cliente, orden, historial) en un segundo bloque sin caché o en
el mensaje de usuario. Con tráfico real, esto baja el costo por mensaje ~40-60%.
No se aplicó en esta sesión: toca `claude-client.js` y `prompts.js` (zona "no
tocar" sin instrucción explícita) y merece su propia prueba de regresión de tono.

## Llamadas a Claude evitables (estado actual: bien)

Ya resueltas sin Claude: `/start` y comandos de bot (respuesta fija), botones
BASICO/FULL (`servicio_*` se resuelve en código), reacciones (ignoradas),
números bloqueados (retorno temprano). Restante menor: los mensajes `audio` y
tipos no soportados sí llaman a Claude solo para decir "no puedo escucharlo" —
una respuesta fija ahorraría esa llamada, a costa de sonar menos natural.
Volumen actual ≈ 0; no vale el cambio todavía.

## Cola de jobs

`cola_jobs`: 968 `completado`, 10 `fallido_permanente` (incidente jobs huérfanos,
ya documentado), 0 atascados en `pendiente`/`procesando`. El reaper mantiene la
cola limpia. La tabla `cola_jobs_backup_20260707` (46 filas) es el respaldo del
incidente — borrable cuando Rodrigo lo decida (`DROP TABLE`, requiere
confirmación explícita por regla del proyecto).

## Inventario de tablas Supabase (filas al 9 Jul)

| Tabla | Filas | Nota |
|---|---|---|
| clientes | 2 | 1 real + 1 spammer |
| ordenes | 1 | P123ABC en ESPERANDO_PAGO |
| conversaciones | 943 | ~926 son spam — purgables si se quiere aligerar |
| revisiones | 0 | P926FTB nunca fue re-reportada (la orden ya no existe) |
| notificaciones | 0 | |
| cola_jobs | 978 | completados purgables con retención (p.ej. >30 días) |
| cola_jobs_backup_20260707 | 46 | respaldo del incidente P0 |
| costos_api | 943 | histórico de gasto — conservar |
| tokens_aprobacion | 0 | flujo alternativo de aprobación, sin uso aún |
| fotos_inspeccion | 0 | nueva (migración 008) |

## Limpieza hecha en esta sesión

- Código muerto eliminado (commit `b3939b2`): `obtenerConversacionesPorPlaca`,
  `obtenerNotificacionesPendientes`, `marcarNotificacionEnviada` (db.js),
  `obtenerImagenTelegram` (telegram-client.js), `validatePuntoActual`
  (validators.js) y sus tests. El flujo de tokens de aprobación
  (`pdf-approval.js`) se conserva: no está cableado a rutas, pero es el candidato
  natural para la aprobación vía web (ver API_CONTRACT_WEB.md).
- Ramas locales mergeadas borradas. Las remotas mergeadas quedan para Rodrigo —
  **comando destructivo: revisar la lista con `git branch -r --merged origin/main`
  antes de correrlo** (el harness bloquea el borrado masivo remoto, correcto):
  `git branch -r --merged origin/main | grep -v 'HEAD\|origin/main' | sed 's|origin/||' | xargs -n1 git push origin --delete`
