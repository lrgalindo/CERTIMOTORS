export const QUEUE_CONCURRENCY = Number(process.env.QUEUE_CONCURRENCY) || 10;
export const QUEUE_POLL_INTERVAL_MS = Number(process.env.QUEUE_POLL_INTERVAL_MS) || 5000;

export function calcularBackoffMs(intentos) {
  return 1000 * 2 ** (intentos - 1);
}

export function calcularProximoIntento(intentos) {
  return new Date(Date.now() + calcularBackoffMs(intentos)).toISOString();
}
