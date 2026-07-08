export const QUEUE_CONCURRENCY = Number(process.env.QUEUE_CONCURRENCY) || 10;
export const QUEUE_POLL_INTERVAL_MS = Number(process.env.QUEUE_POLL_INTERVAL_MS) || 5000;

// Transición de estado de un job que falló (o fue rescatado por el reaper):
// reencolar mientras queden intentos, permanente cuando se agotan. Vive acá
// (puro, sin Supabase) para poder testear la transición completa del reaper.
export function statusTrasFallo(intentos, maxIntentos) {
  return intentos >= maxIntentos ? 'fallido_permanente' : 'pendiente';
}

export function calcularBackoffMs(intentos) {
  return 1000 * 2 ** (intentos - 1);
}

export function calcularProximoIntento(intentos) {
  return new Date(Date.now() + calcularBackoffMs(intentos)).toISOString();
}
