import 'dotenv/config.js';
import axios from 'axios';
import express from 'express';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import * as db from './db.js';
import { prompts } from './prompts.js';
import { logger } from './logger.js';
import { handleError, AppError } from './errors.js';
import { validatePlaca } from './validators.js';
import generalRateLimit from './ratelimit.js';
import { llamarClaudeAPI } from './claude-client.js';
import { verificarPresupuesto } from './budget-tracker.js';
import { iniciarWorker } from './worker.js';
import { registrarWebhookTelegram } from './telegram-client.js';
import { verificarFirmaWhatsapp, verificarSecretoTelegram, verificarFirmaRecurrente } from './webhook-security.js';
import { procesarPagoRecurrente } from './processors.js';
import { validarOrden } from './validar-orden.js';
import { crearBackofficeRouter } from './backoffice.js';

// Sin timeout, un socket colgado (Meta/Telegram/Recurrente) deja la promesa sin
// resolver para siempre y el job muere en `procesando` con error null (incidente
// jobs huérfanos, jul 2026). Aplica a todas las llamadas axios del proceso;
// claude-client.js sobreescribe con un timeout mayor para respuestas largas.
axios.defaults.timeout = Number(process.env.HTTP_TIMEOUT_MS) || 15000;

const app = express();
app.set('trust proxy', 1);
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(compression());
app.use(generalRateLimit);

// Rate limiter más estricto para endpoints de checkout (pago real)
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Demasiadas solicitudes, intenta más tarde',
  standardHeaders: true,
  legacyHeaders: false,
});

// CORS para el checkout web (certimotors.com → certimotors.onrender.com)
const corsCheckout = (req, res, next) => {
  const origin = req.get('Origin') || '';
  const allowedOrigins = (CONFIG.CORS_ORIGIN || 'https://certimotors.com').split(',').map(o => o.trim());
  if (allowedOrigins.includes(origin) || CONFIG.NODE_ENV !== 'production') {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://certimotors.com');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};

// Planes válidos: nombre → monto en centavos de GTQ
const PLANES = {
  SCANNER:  { label: 'Inspección SCANNER — CERTIMOTORS',                      centavos: 30000 },
  ESTANDAR: { label: 'Inspección ESTÁNDAR 110 puntos — CERTIMOTORS',          centavos: 55000 },
  FULL:     { label: 'Inspección FULL + Verificación Legal — CERTIMOTORS',    centavos: 80000 },
};

const CONFIG = {
  PORT: process.env.PORT || 3000,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
  TELEGRAM_MECANICO_BOT_TOKEN: process.env.TELEGRAM_MECANICO_BOT_TOKEN,
  TELEGRAM_TRAMITADOR_BOT_TOKEN: process.env.TELEGRAM_TRAMITADOR_BOT_TOKEN,
  TELEGRAM_MECANICO_WEBHOOK_SECRET: process.env.TELEGRAM_MECANICO_WEBHOOK_SECRET,
  TELEGRAM_TRAMITADOR_WEBHOOK_SECRET: process.env.TELEGRAM_TRAMITADOR_WEBHOOK_SECRET,
  PUBLIC_URL: process.env.PUBLIC_URL || 'http://localhost:3000',
  NODE_ENV: process.env.NODE_ENV || 'development',
  // Checkout web
  RECURRENTE_SECRET_KEY:       process.env.RECURRENTE_SECRET_KEY,
  RECURRENTE_WEBHOOK_SECRET:   process.env.RECURRENTE_WEBHOOK_SECRET,
  TELEGRAM_MECANICO_CHAT_ID:   process.env.TELEGRAM_MECANICO_CHAT_ID,
  TELEGRAM_TRAMITADOR_CHAT_ID: process.env.TELEGRAM_TRAMITADOR_CHAT_ID,
  WEB_URL:     process.env.WEB_URL     || 'https://certimotors.com',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'https://certimotors.com',
};

const METRICS = {
  totalRequests: 0,
  totalErrors: 0,
  startTime: new Date(),
};

app.get('/', (req, res) => {
  res.json({
    status: '✅ VIVO',
    app: 'CERTIMOTORS',
    version: '1.0.0',
    env: CONFIG.NODE_ENV,
    database: process.env.DATABASE_TYPE,
    model_router: 'activo',
    timestamp: new Date().toISOString(),
    uptime: Math.round((new Date() - METRICS.startTime) / 1000),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', async (req, res) => {
  const stats = await db.obtenerEstadisticas();
  res.json({
    uptime: Math.round((new Date() - METRICS.startTime) / 1000),
    totalRequests: METRICS.totalRequests,
    totalErrors: METRICS.totalErrors,
    ...stats,
  });
});

app.get('/webhook/whatsapp', (req, res) => {
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (token === CONFIG.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    res.send(challenge);
    logger.info('WhatsApp webhook validated');
  } else {
    res.status(403).send('Token inválido');
    logger.error('Invalid WhatsApp token');
  }
});

// Patrón ack-then-process: cada webhook solo encola el job y responde 200 de
// inmediato. El procesamiento real (Claude, DB, envío de respuesta) corre en
// src/worker.js fuera del ciclo request/response. Esto evita timeouts del
// proveedor (WhatsApp/Telegram) cuando Claude tarda, y permite reintentos
// automáticos vía cola_jobs sin perder el mensaje del usuario.
app.post('/webhook/whatsapp', async (req, res) => {
  METRICS.totalRequests++;

  const firmaValida = verificarFirmaWhatsapp(
    req.rawBody,
    req.get('x-hub-signature-256'),
    CONFIG.WHATSAPP_APP_SECRET
  );
  if (!firmaValida) {
    METRICS.totalErrors++;
    logger.error('WhatsApp webhook: firma inválida', { ip: req.ip });
    return res.status(401).json({ error: 'Firma inválida' });
  }

  try {
    const externalId = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;
    if (!externalId) return res.status(200).json({ ok: true });

    await db.encolarJob('whatsapp', externalId, req.body);
    res.status(200).json({ ok: true });
  } catch (error) {
    METRICS.totalErrors++;
    logger.error('WhatsApp webhook error', { error: error.message });
    res.status(200).json({ ok: true });
  }
});

app.post('/webhook/telegram/mecanico', async (req, res) => {
  METRICS.totalRequests++;

  const secretoValido = verificarSecretoTelegram(
    req.get('x-telegram-bot-api-secret-token'),
    CONFIG.TELEGRAM_MECANICO_WEBHOOK_SECRET
  );
  if (!secretoValido) {
    METRICS.totalErrors++;
    logger.error('Telegram mecánico webhook: secreto inválido', { ip: req.ip });
    return res.status(401).json({ error: 'Secreto inválido' });
  }

  try {
    const externalId = req.body?.update_id;
    if (externalId === undefined) return res.status(200).json({ ok: true });

    const proveedor = req.body?.callback_query ? 'telegram_admin_callback' : 'telegram_mecanico';
    await db.encolarJob(proveedor, String(externalId), req.body);
    res.status(200).json({ ok: true });
  } catch (error) {
    METRICS.totalErrors++;
    logger.error('Telegram mechanic webhook error', { error: error.message });
    res.status(200).json({ ok: true });
  }
});

app.post('/webhook/telegram/tramitador', async (req, res) => {
  METRICS.totalRequests++;

  const secretoValido = verificarSecretoTelegram(
    req.get('x-telegram-bot-api-secret-token'),
    CONFIG.TELEGRAM_TRAMITADOR_WEBHOOK_SECRET
  );
  if (!secretoValido) {
    METRICS.totalErrors++;
    logger.error('Telegram tramitador webhook: secreto inválido', { ip: req.ip });
    return res.status(401).json({ error: 'Secreto inválido' });
  }

  try {
    const externalId = req.body?.update_id;
    if (externalId === undefined) return res.status(200).json({ ok: true });

    await db.encolarJob('telegram_tramitador', String(externalId), req.body);
    res.status(200).json({ ok: true });
  } catch (error) {
    METRICS.totalErrors++;
    logger.error('Telegram processor webhook error', { error: error.message });
    res.status(200).json({ ok: true });
  }
});

app.post('/api/validar-orden', async (req, res) => {
  try {
    const { placa } = req.body;
    validatePlaca(placa);

    const { porcentaje, completadas, validacion } = await validarOrden(db, CONFIG.ANTHROPIC_API_KEY, placa);

    logger.success('Order validated', { placa, porcentaje });

    res.json({
      status: 'ok',
      placa,
      porcentaje_completado: porcentaje,
      puntos_completados: completadas,
      validacion,
    });
  } catch (error) {
    METRICS.totalErrors++;
    logger.error('Order validation error', { error: error.message });
    handleError(error, res);
  }
});

app.post('/api/reporte-diario', async (req, res) => {
  try {
    const [stats, statsReporte, presupuesto] = await Promise.all([
      db.obtenerEstadisticas(),
      db.obtenerStatsReporte(),
      verificarPresupuesto(db),
    ]);

    const statsConCosto = {
      ...stats,
      ...statsReporte,
      gasto_mensual_usd: Number(presupuesto.gastoMensual.toFixed(2)),
      presupuesto_limite_usd: presupuesto.limite,
      presupuesto_porcentaje: Math.round(presupuesto.porcentaje * 100),
      presupuesto_nivel: presupuesto.nivel,
    };

    const systemPrompt = prompts.construirSystemPromptReporter();
    const respuestaReporter = await llamarClaudeAPI(
      CONFIG.ANTHROPIC_API_KEY,
      db,
      systemPrompt,
      [
        {
          role: 'user',
          content: `Generar reporte: ${JSON.stringify(statsConCosto)}`,
        },
      ],
      'reporter'
    );

    logger.success('Daily report generated');

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      estadisticas: statsConCosto,
      reporte: respuestaReporter,
    });
  } catch (error) {
    METRICS.totalErrors++;
    logger.error('Daily report error', { error: error.message });
    handleError(error, res);
  }
});

// ── CHECKOUT WEB ─────────────────────────────────────────────────────────────

// POST /api/ordenes — registra cliente + orden antes del pago (status PENDIENTE_PAGO)
app.options('/api/ordenes', corsCheckout);
app.post('/api/ordenes', corsCheckout, checkoutLimiter, async (req, res) => {
  try {
    const { nombre, telefono, email, placa, marca, modelo, anio, zona, fecha_preferida, servicio } = req.body;

    if (!nombre?.trim())    throw new AppError('Nombre requerido', 400);
    if (!zona?.trim())      throw new AppError('Zona requerida', 400);
    if (!servicio || !PLANES[servicio]) throw new AppError('Servicio inválido', 400);

    // Normalizar y validar teléfono (strip non-digits)
    const telefonoLimpio = (telefono || '').replace(/\D/g, '');
    if (telefonoLimpio.length < 8) throw new AppError('Teléfono inválido', 400);

    if (!email?.trim() || !email.includes('@')) throw new AppError('Email inválido', 400);

    const placaFinal = placa?.trim().toUpperCase();
    if (!placaFinal) throw new AppError('Placa requerida', 400);
    validatePlaca(placaFinal);

    // Buscar o crear cliente por teléfono
    let cliente = await db.obtenerClientePorNumero(telefonoLimpio);
    if (!cliente) {
      cliente = await db.crearCliente(telefonoLimpio, { nombre: nombre.trim(), tipo: 'CLIENTE' });
    }

    // Si ya existe una orden PENDIENTE_PAGO para esta placa, reutilizarla
    const ordenExistente = await db.obtenerOrdenPorPlaca(placaFinal);
    if (ordenExistente) {
      if (ordenExistente.status === 'PENDIENTE_PAGO') {
        return res.status(200).json({ orden_id: ordenExistente.id, placa: placaFinal });
      }
      throw new AppError('Ya existe una inspección activa para esta placa', 409);
    }

    const orden = await db.crearOrdenWeb({
      placa: placaFinal,
      cliente_id: cliente.id,
      servicio,
      nombre_cliente: nombre.trim(),
      email: email.trim(),
      zona: zona.trim(),
      fecha_preferida: fecha_preferida || null,
      marca: marca?.trim() || null,
      modelo: modelo?.trim() || null,
      anio: anio || null,
    });

    logger.success('Web order created', { placa: placaFinal, servicio });
    res.status(201).json({ orden_id: orden.id, placa: placaFinal });
  } catch (error) {
    METRICS.totalErrors++;
    logger.error('Web order error', { error: error.message });
    handleError(error, res);
  }
});

// POST /api/pagos/crear-checkout — crea sesión en Recurrente y devuelve checkout_url
app.options('/api/pagos/crear-checkout', corsCheckout);
app.post('/api/pagos/crear-checkout', corsCheckout, checkoutLimiter, async (req, res) => {
  try {
    const { orden_id } = req.body;
    if (!orden_id) throw new AppError('orden_id requerido', 400);

    const orden = await db.obtenerOrdenPorId(orden_id);
    if (!orden) throw new AppError('Orden no encontrada', 404);
    if (!['PENDIENTE_PAGO', 'INICIADA'].includes(orden.status)) {
      throw new AppError('Esta orden ya fue procesada', 409);
    }

    if (!CONFIG.RECURRENTE_SECRET_KEY) {
      throw new AppError('Procesador de pago no configurado', 503);
    }

    const plan = PLANES[orden.servicio];
    if (!plan) throw new AppError('Servicio de orden inválido', 400);

    const respuesta = await axios.post(
      'https://app.recurrente.com/api/checkouts',
      {
        items: [{ name: plan.label, amount_in_cents: plan.centavos, currency: 'GTQ', quantity: 1 }],
        success_url: `${CONFIG.WEB_URL}?paid=1&orden=${orden.id}`,
        cancel_url:  `${CONFIG.WEB_URL}/#servicios`,
        metadata:    { orden_id: orden.id, placa: orden.placa, servicio: orden.servicio },
      },
      {
        headers: { 'X-SECRET-KEY': CONFIG.RECURRENTE_SECRET_KEY, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    const { checkout_url, id: checkoutId } = respuesta.data;
    if (checkoutId) await db.guardarCheckoutIdOrden(orden.id, checkoutId);

    logger.success('Recurrente checkout created', { orden_id: orden.id, servicio: orden.servicio });
    res.json({ checkout_url });
  } catch (error) {
    METRICS.totalErrors++;
    logger.error('Checkout creation error', { error: error.response?.data || error.message });
    handleError(error instanceof AppError ? error : new AppError('Error al crear el pago', 502), res);
  }
});

// POST /webhook/recurrente — confirma pago y dispara notificaciones Telegram
app.post('/webhook/recurrente', async (req, res) => {
  const firmaValida = verificarFirmaRecurrente(
    req.rawBody,
    req.headers,
    CONFIG.RECURRENTE_WEBHOOK_SECRET
  );
  if (!firmaValida) {
    METRICS.totalErrors++;
    logger.error('Recurrente webhook: firma inválida', { ip: req.ip });
    return res.status(401).json({ error: 'Firma inválida' });
  }

  // Responder 200 de inmediato (ack-then-process)
  res.status(200).json({ ok: true });

  const { event_type, checkout, metadata } = req.body;
  if (event_type !== 'intent.succeeded') return;

  const checkoutId = checkout?.id;
  const ordenIdMeta = metadata?.orden_id;

  try {
    // Buscar orden por checkout_id (principal) o por metadata.orden_id (fallback)
    let orden = checkoutId ? await db.obtenerOrdenPorCheckoutId(checkoutId) : null;
    if (!orden && ordenIdMeta) orden = await db.obtenerOrdenPorId(ordenIdMeta);
    if (!orden) {
      logger.warn('Recurrente webhook: sin orden asociada', { checkoutId, ordenIdMeta });
      return;
    }

    // Idempotencia: si ya está PAGADA, ignorar
    if (orden.status === 'PAGADA') {
      logger.info('Recurrente webhook idempotente — orden ya pagada', { placa: orden.placa });
      return;
    }

    await db.actualizarStatusOrden(orden.placa, 'PAGADA');
    await db.crearNotificacion(orden.placa, 'PAGO_CONFIRMADO', `Pago confirmado vía web (checkout ${checkoutId || 'N/D'})`);
    logger.success('Payment confirmed via web', { placa: orden.placa, servicio: orden.servicio });

    // Encola la notificación a Telegram como job reintentable.
    // Si Telegram está caído o el chat_id es inválido, el worker reintenta con
    // backoff exponencial en vez de perder la notificación silenciosamente.
    await db.encolarJob('notificar_equipo', orden.id, { orden_id: orden.id });
  } catch (error) {
    METRICS.totalErrors++;
    logger.error('Recurrente webhook processing error', { error: error.message });
  }
});

app.use('/backoffice', crearBackofficeRouter(db));

app.use((req, res) => {
  handleError(new AppError('Ruta no encontrada', 404), res);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message });
  handleError(err, res);
});

async function start() {
  try {
    await db.initDB();

    app.listen(CONFIG.PORT, async () => {
      logger.success(`Backend listening on port ${CONFIG.PORT}`);
      logger.info('CERTIMOTORS activated', {
        model_router: 'activo',
        database: process.env.DATABASE_TYPE,
        environment: CONFIG.NODE_ENV,
        url: `http://localhost:${CONFIG.PORT}`,
      });

      iniciarWorker();

      // El registro automático contra Telegram solo corre si se confirma explícitamente
      // vía esta env var — evita reapuntar webhooks de producción en cada deploy/restart
      // sin confirmación (checkpoint: Tarea 3.2).
      if (process.env.TELEGRAM_AUTO_REGISTER_WEBHOOK === 'true') {
        await registrarWebhookTelegram(
          CONFIG.TELEGRAM_MECANICO_BOT_TOKEN,
          `${CONFIG.PUBLIC_URL}/webhook/telegram/mecanico`,
          'Mecánico',
          CONFIG.TELEGRAM_MECANICO_WEBHOOK_SECRET
        );
        await registrarWebhookTelegram(
          CONFIG.TELEGRAM_TRAMITADOR_BOT_TOKEN,
          `${CONFIG.PUBLIC_URL}/webhook/telegram/tramitador`,
          'Tramitador',
          CONFIG.TELEGRAM_TRAMITADOR_WEBHOOK_SECRET
        );
      }
    });
  } catch (error) {
    logger.error('Startup failed', { error: error.message });
    process.exit(1);
  }
}

start();

export default app;
