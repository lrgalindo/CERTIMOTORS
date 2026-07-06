import axios from 'axios';
import * as db from './db.js';
import { logger } from './logger.js';
import { procesarWhatsapp, procesarTelegramMecanico, procesarTelegramTramitador } from './processors.js';
import { procesarCallbackAdmin, ADMIN_CHAT_ID } from './pdf-approval.js';
import { enviarMensajeTelegram } from './telegram-client.js';
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
    const permanente = intentos >= job.max_intentos;
    logger.error('Job de cola falló', {
      jobId: job.id,
      proveedor: job.proveedor,
      intentos,
      permanente,
      error: error.message,
    });
    await dbDep.marcarJobFallido(job.id, {
      intentos,
      maxIntentos: job.max_intentos,
      error: error.message,
      proximoIntentoEn: calcularProximoIntento(intentos),
    });

    if (permanente && job.proveedor === 'whatsapp') {
      const numero = claveCliente(job).split(':')[1];
      if (numero) {
        // Aviso al cliente: best-effort, no bloquea ni propaga error.
        try {
          const graphBase = process.env.WHATSAPP_GRAPH_API_URL || 'https://graph.facebook.com';
          await axios.post(
            `${graphBase}/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: 'whatsapp',
              to: numero,
              type: 'text',
              text: { body: 'Estamos teniendo dificultades técnicas, te contactamos en menos de una hora.' },
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
              },
            }
          );
        } catch (wa) {
          logger.error('No se pudo avisar al cliente del fallo permanente', { numero, error: wa.message });
        }
      }

      // Alerta al admin: best-effort.
      try {
        await enviarMensajeTelegram(
          process.env.TELEGRAM_MECANICO_BOT_TOKEN,
          ADMIN_CHAT_ID,
          `⚠️ Job WhatsApp fallido permanente\n\nProveedor: ${job.proveedor}\nCliente: ${numero || 'desconocido'}\nError: ${error.message}`
        );
      } catch (tg) {
        logger.error('No se pudo enviar alerta Telegram del fallo permanente', { error: tg.message });
      }
    }
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
