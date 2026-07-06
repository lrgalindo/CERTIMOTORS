import * as db from './db.js';
import { logger } from './logger.js';
import { procesarWhatsapp, procesarTelegramMecanico, procesarTelegramTramitador } from './processors.js';
import { procesarCallbackAdmin } from './pdf-approval.js';
import { QUEUE_CONCURRENCY, QUEUE_POLL_INTERVAL_MS, calcularProximoIntento } from './queue.js';

const CONFIG = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  TELEGRAM_MECANICO_BOT_TOKEN: process.env.TELEGRAM_MECANICO_BOT_TOKEN,
  TELEGRAM_TRAMITADOR_BOT_TOKEN: process.env.TELEGRAM_TRAMITADOR_BOT_TOKEN,
};

const PROCESADORES = {
  whatsapp: (payload) => procesarWhatsapp(db, payload, CONFIG.ANTHROPIC_API_KEY),
  telegram_mecanico: (payload) =>
    procesarTelegramMecanico(db, payload, CONFIG.TELEGRAM_MECANICO_BOT_TOKEN, CONFIG.ANTHROPIC_API_KEY),
  telegram_tramitador: (payload) =>
    procesarTelegramTramitador(db, payload, CONFIG.TELEGRAM_TRAMITADOR_BOT_TOKEN, CONFIG.ANTHROPIC_API_KEY),
  telegram_admin_callback: (payload) =>
    procesarCallbackAdmin(db, payload, CONFIG.TELEGRAM_MECANICO_BOT_TOKEN),
};

export async function procesarJob({ db: dbDep, procesadores }, job) {
  const procesador = procesadores[job.proveedor];

  if (!procesador) {
    logger.error('Proveedor desconocido en cola_jobs', { proveedor: job.proveedor, jobId: job.id });
    await dbDep.marcarJobFallido(job.id, {
      intentos: job.max_intentos,
      maxIntentos: job.max_intentos,
      error: `Proveedor desconocido: ${job.proveedor}`,
      proximoIntentoEn: new Date().toISOString(),
    });
    return;
  }

  try {
    await procesador(job.payload);
    await dbDep.marcarJobCompletado(job.id);
  } catch (error) {
    const intentos = job.intentos + 1;
    logger.error('Job de cola falló', {
      jobId: job.id,
      proveedor: job.proveedor,
      intentos,
      error: error.message,
    });
    await dbDep.marcarJobFallido(job.id, {
      intentos,
      maxIntentos: job.max_intentos,
      error: error.message,
      proximoIntentoEn: calcularProximoIntento(intentos),
    });
  }
}

// Identifica al cliente dueño del job para poder secuenciar sus mensajes.
// Sin clave extraíble, el job va solo en su propio grupo (se procesa igual).
export function claveCliente(job) {
  const p = job.payload;
  const clave =
    job.proveedor === 'whatsapp'
      ? p?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from
      : p?.message?.from?.id || p?.callback_query?.from?.id;
  return clave ? `${job.proveedor}:${clave}` : `job:${job.id}`;
}

// Los jobs llegan ordenados por created_at (ORDER BY del RPC reclamar_jobs_pendientes).
// Mismo cliente → en secuencia, para no responder mensajes fuera de orden;
// clientes distintos → en paralelo, manteniendo la concurrencia del worker.
export async function procesarLote(deps, jobs) {
  const grupos = new Map();
  for (const job of jobs) {
    const clave = claveCliente(job);
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(job);
  }
  await Promise.allSettled(
    [...grupos.values()].map(async (grupo) => {
      for (const job of grupo) {
        await procesarJob(deps, job);
      }
    })
  );
}

async function tick() {
  try {
    const jobs = await db.reclamarJobsPendientes(QUEUE_CONCURRENCY);
    if (jobs.length > 0) {
      logger.info(`Worker: ${jobs.length} job(s) reclamado(s)`);
      await procesarLote({ db, procesadores: PROCESADORES }, jobs);
    }
  } catch (error) {
    logger.error('Error en ciclo del worker', { error: error.message });
  }
}

let intervalId = null;

export function iniciarWorker() {
  if (intervalId) return;
  intervalId = setInterval(tick, QUEUE_POLL_INTERVAL_MS);
  logger.success('Worker de cola iniciado', {
    concurrencia: QUEUE_CONCURRENCY,
    intervaloMs: QUEUE_POLL_INTERVAL_MS,
  });
}

export function detenerWorker() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
