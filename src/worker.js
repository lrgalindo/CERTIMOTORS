import axios from 'axios';
import * as db from './db.js';
import { logger } from './logger.js';
import { procesarWhatsapp, procesarTelegramMecanico, procesarTelegramTramitador } from './processors.js';
import { procesarCallbackAdmin, ADMIN_CHAT_ID } from './pdf-approval.js';
import { enviarMensajeTelegram } from './telegram-client.js';
import { enviarAlMecanico, enviarAlTramitador } from './notificaciones.js';
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
  notificar_equipo: async ({ orden_id }) => {
    const orden = await db.obtenerOrdenPorId(orden_id);
    if (!orden) throw new Error(`Orden ${orden_id} no encontrada`);
    if (orden.notificado_at) return; // guard para órdenes ya completamente notificadas

    const mecanicoHecho = !!orden.mecanico_notificado_at;
    const tramitadorHecho = orden.servicio !== 'FULL' || !!orden.tramitador_notificado_at;
    if (mecanicoHecho && tramitadorHecho) return; // todos los destinatarios marcados (race condition muy improbable)

    const cliente = await db.obtenerClientePorId(orden.cliente_id);

    if (!mecanicoHecho) {
      const enviado = await enviarAlMecanico(orden, cliente); // lanza si falla API → worker reintenta
      if (!enviado) return; // config faltante → job completado, notificado_at queda NULL
      await db.marcarMecanicoNotificado(orden_id);
    }

    if (orden.servicio === 'FULL' && !tramitadorHecho) {
      const enviado = await enviarAlTramitador(orden, cliente); // lanza si falla API → worker reintenta
      if (!enviado) {
        logger.warn('FULL incompleto: tramitador sin config — notificado_at quedará NULL', {
          placa: orden.placa,
          mecanico_notificado: true,
        });
        return;
      }
      await db.marcarTramitadorNotificado(orden_id);
    }

    await db.marcarOrdenNotificada(orden_id);
  },
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

    if (permanente) {
      await notificarFalloPermanente(job, error.message);
    }
  }
}

// Avisos best-effort cuando un job agota sus reintentos: el cliente WhatsApp
// recibe un mensaje de disculpa y Rodrigo una alerta por Telegram. Usado tanto
// por el fallo normal (catch de procesarJob) como por el reaper de huérfanos.
export async function notificarFalloPermanente(job, errorMsg) {
  const numero = job.proveedor === 'whatsapp' ? claveCliente(job).split(':')[1] : null;
  if (numero) {
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

  try {
    await enviarMensajeTelegram(
      process.env.TELEGRAM_MECANICO_BOT_TOKEN,
      ADMIN_CHAT_ID,
      `⚠️ Job fallido permanente\n\nProveedor: ${job.proveedor}\nCliente: ${numero || claveCliente(job)}\nError: ${errorMsg}`
    );
  } catch (tg) {
    logger.error('No se pudo enviar alerta Telegram del fallo permanente', { error: tg.message });
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

// ─── Reaper de jobs huérfanos ────────────────────────────────────────────────
// Un job que muere en `procesando` (deploy a mitad de proceso, promesa colgada,
// crash) no lo recupera nadie: este reaper detecta los que llevan más del umbral
// sin actualizarse y los reencola vía marcarJobFallido, que ya decide entre
// `pendiente` (reintento) y `fallido_permanente` (agotó intentos → alerta admin).
// El procesamiento normal tarda segundos y el peor caso con timeouts es ~60s por
// llamada; 10 minutos no puede ser un job vivo.
export const REAPER_UMBRAL_MS = Number(process.env.REAPER_UMBRAL_MS) || 10 * 60 * 1000;
export const REAPER_INTERVAL_MS = Number(process.env.REAPER_INTERVAL_MS) || 60 * 1000;

export async function recuperarJobsHuerfanos({ db: dbDep }) {
  const huerfanos = await dbDep.obtenerJobsHuerfanos(REAPER_UMBRAL_MS);
  for (const job of huerfanos) {
    const intentos = job.intentos + 1;
    const permanente = intentos >= job.max_intentos;
    logger.warn('Job huérfano detectado, recuperando', {
      jobId: job.id,
      proveedor: job.proveedor,
      intentos,
      permanente,
    });
    await dbDep.marcarJobFallido(job.id, {
      intentos,
      maxIntentos: job.max_intentos,
      error: `Job huérfano: >${Math.round(REAPER_UMBRAL_MS / 60000)} min en 'procesando' sin resolverse`,
      proximoIntentoEn: new Date().toISOString(),
    });
    if (permanente) {
      await notificarFalloPermanente(job, 'Job huérfano: agotó reintentos sin resolverse');
    }
  }
  return huerfanos.length;
}

async function tickReaper() {
  try {
    await recuperarJobsHuerfanos({ db });
  } catch (error) {
    logger.error('Error en reaper de jobs huérfanos', { error: error.message });
  }
}

let intervalId = null;
let reaperId = null;

export function iniciarWorker() {
  if (intervalId) return;
  intervalId = setInterval(tick, QUEUE_POLL_INTERVAL_MS);
  reaperId = setInterval(tickReaper, REAPER_INTERVAL_MS);
  logger.success('Worker de cola iniciado', {
    concurrencia: QUEUE_CONCURRENCY,
    intervaloMs: QUEUE_POLL_INTERVAL_MS,
    reaperUmbralMs: REAPER_UMBRAL_MS,
  });
}

export function detenerWorker() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (reaperId) {
    clearInterval(reaperId);
    reaperId = null;
  }
}
