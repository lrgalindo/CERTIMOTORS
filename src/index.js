import 'dotenv/config.js';
import express from 'express';
import compression from 'compression';
import * as db from './db.js';
import { prompts } from './prompts.js';
import { logger } from './logger.js';
import { handleError, AppError } from './errors.js';
import { validatePlaca } from './validators.js';
import rateLimit from './ratelimit.js';
import { llamarClaudeAPI } from './claude-client.js';
import { verificarPresupuesto } from './budget-tracker.js';
import { iniciarWorker } from './worker.js';
import { registrarWebhookTelegram } from './telegram-client.js';
import { verificarFirmaWhatsapp, verificarSecretoTelegram } from './webhook-security.js';
import { validarOrden } from './validar-orden.js';

const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(compression());
app.use(rateLimit);

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

    await db.encolarJob('telegram_mecanico', String(externalId), req.body);
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
    const stats = await db.obtenerEstadisticas();
    const presupuesto = await verificarPresupuesto(db);

    const statsConCosto = {
      ...stats,
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
