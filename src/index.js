import 'dotenv/config.js';
import express from 'express';
import axios from 'axios';
import compression from 'compression';
import * as db from './db.js';
import { prompts } from './prompts.js';
import { logger } from './logger.js';
import { handleError, AppError, ClaudeAPIError } from './errors.js';
import {
  validatePlaca,
  validatePhoneNumber,
  validateMessage,
  validatePuntoActual,
} from './validators.js';
import rateLimit from './ratelimit.js';
import { seleccionarModeloPorRol } from './model-router.js';

const app = express();
app.use(express.json());
app.use(compression());
app.use(rateLimit);

const CONFIG = {
  PORT: process.env.PORT || 3000,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  PUBLIC_URL: process.env.PUBLIC_URL || 'http://localhost:3000',
  NODE_ENV: process.env.NODE_ENV || 'development',
};

const METRICS = {
  totalRequests: 0,
  totalErrors: 0,
  startTime: new Date(),
};

async function llamarClaudeAPI(systemPrompt, messages, rol) {
  const { modelo, maxTokens } = seleccionarModeloPorRol(rol);

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: modelo,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
      },
      {
        headers: {
          'x-api-key': CONFIG.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );

    const texto = response.data.content[0]?.text || '';
    const tokens = response.data.usage?.output_tokens || 0;

    logger.debug('Claude API response', { tokens, modelo, rol });
    return texto;
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    logger.error('Claude API error', { error: errorMsg, modelo, rol });
    throw new ClaudeAPIError(`Claude API: ${errorMsg}`, error);
  }
}

function extraerPlaca(texto) {
  const match = texto.match(/[A-Z]\d{3}[A-Z]{3}/);
  return match ? match[0] : null;
}

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

app.post('/webhook/whatsapp', async (req, res) => {
  METRICS.totalRequests++;

  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages || [];
    if (messages.length === 0) return res.status(200).json({ ok: true });

    const mensaje = messages[0];
    const numeroCliente = mensaje.from;
    const textoCliente = mensaje.text.body;

    validatePhoneNumber(numeroCliente);
    validateMessage(textoCliente);

    logger.info(`WhatsApp: +${numeroCliente}`, { text: textoCliente.substring(0, 50) });

    const placa = extraerPlaca(textoCliente);
    let cliente = await db.obtenerClientePorNumero(numeroCliente);
    let orden = null;

    if (!cliente) {
      cliente = await db.crearCliente(numeroCliente, { nombre: 'Cliente', tipo: 'CLIENTE' });
      logger.success(`New client: +${numeroCliente}`);
    }

    if (placa) {
      validatePlaca(placa);
      orden = await db.obtenerOrdenPorPlaca(placa);
      if (!orden) {
        orden = await db.crearOrden(placa, { cliente_id: cliente.id, tipo_auto: 'RODADO' });
        logger.success(`New order: ${placa}`);
      }
    }

    const historial = placa ? await db.obtenerConversacionesPorPlaca(placa) : [];
    const historialTexto = historial
      .slice(-3)
      .map((c) => `${c.tipo_usuario}: ${c.mensaje_entrada}`)
      .join('\n');

    const systemPrompt = prompts.construirSystemPromptCliente(
      placa,
      orden,
      cliente,
      historialTexto
    );

    const respuestaClaudeIA = await llamarClaudeAPI(
      systemPrompt,
      [{ role: 'user', content: textoCliente }],
      'cliente'
    );

    if (placa && orden) {
      await db.guardarConversacion(placa, cliente.id, 'CLIENTE', textoCliente, respuestaClaudeIA);
    }

    logger.info('Claude response sent', { text: respuestaClaudeIA.substring(0, 50) });

    res.json({
      status: 'ok',
      respuesta: respuestaClaudeIA,
      placa: placa || null,
    });
  } catch (error) {
    METRICS.totalErrors++;
    logger.error('WhatsApp webhook error', { error: error.message });
    res.status(200).json({ ok: true });
  }
});

app.post('/webhook/telegram', async (req, res) => {
  METRICS.totalRequests++;

  try {
    const { message } = req.body;

    if (!message || !message.text) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const telegram_id = message.from.id;
    const texto = message.text;
    const userName = message.from?.first_name || 'Usuario';

    logger.info(`Telegram: ${userName} (${telegram_id})`, { text: texto.substring(0, 50) });

    const placa = extraerPlaca(texto);
    let punto_actual = 1;

    if (placa) {
      const orden = await db.obtenerOrdenPorPlaca(placa);
      if (orden) {
        const revisiones = await db.obtenerRevisionesPorPlaca(placa);
        punto_actual = revisiones.length + 1;
        logger.success(`Order found: ${placa}, point ${punto_actual}`);
      }
    }

    const systemPrompt = placa
      ? prompts.construirSystemPromptMecanico(placa, 'RODADO', punto_actual, texto)
      : 'Eres asistente de CERTIMOTORS. Responde amablemente en español.';

    const respuesta = await llamarClaudeAPI(
      systemPrompt,
      [{ role: 'user', content: texto }],
      'mecanico'
    );

    if (placa) {
      await db.guardarRevision(placa, telegram_id, punto_actual, texto);
    }

    if (CONFIG.TELEGRAM_BOT_TOKEN) {
      try {
        await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: respuesta,
          parse_mode: 'HTML',
        });
        logger.success(`Message sent to Telegram (${chatId})`);
      } catch (error) {
        logger.error('Error sending to Telegram', { error: error.message });
      }
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    METRICS.totalErrors++;
    logger.error('Telegram webhook error', { error: error.message });
    res.status(200).json({ ok: true });
  }
});

app.post('/webhook/telegram/mecanico', async (req, res) => {
  METRICS.totalRequests++;

  try {
    const { message, telegram_id, placa, punto_actual = 1 } = req.body;

    validateMessage(message);
    validatePlaca(placa);
    validatePuntoActual(punto_actual);

    logger.info(`Mechanic (${telegram_id}): point ${punto_actual}`, { placa });

    const orden = await db.obtenerOrdenPorPlaca(placa);
    if (!orden) {
      throw new AppError('Orden no encontrada', 404);
    }

    const systemPrompt = prompts.construirSystemPromptMecanico(
      placa,
      orden.tipo_auto,
      punto_actual,
      message
    );

    const respuestaMecanico = await llamarClaudeAPI(
      systemPrompt,
      [{ role: 'user', content: message }],
      'mecanico'
    );

    await db.guardarRevision(placa, telegram_id, punto_actual, message);

    logger.success('Mechanic response sent');

    res.json({
      status: 'ok',
      respuesta: respuestaMecanico,
      punto_actual: punto_actual + 1,
    });
  } catch (error) {
    METRICS.totalErrors++;
    logger.error('Telegram mechanic error', { error: error.message });
    handleError(error, res);
  }
});

app.post('/webhook/telegram/tramitador', async (req, res) => {
  METRICS.totalRequests++;

  try {
    const { message, telegram_id, placa, etapa = 'Documentación' } = req.body;

    validateMessage(message);
    validatePlaca(placa);

    logger.info(`Processor (${telegram_id}): ${etapa}`, { placa });

    const orden = await db.obtenerOrdenPorPlaca(placa);
    if (!orden) {
      throw new AppError('Orden no encontrada', 404);
    }

    const cliente = await db.obtenerClientePorNumero(orden.cliente_id);

    const systemPrompt = prompts.construirSystemPromptTramitador(placa, cliente, etapa, {
      SAT: 'Pendiente',
    });

    const respuestaTramitador = await llamarClaudeAPI(
      systemPrompt,
      [{ role: 'user', content: message }],
      'tramitador'
    );

    logger.success('Processor response sent');

    res.json({
      status: 'ok',
      respuesta: respuestaTramitador,
      etapa_actual: etapa,
    });
  } catch (error) {
    METRICS.totalErrors++;
    logger.error('Telegram processor error', { error: error.message });
    handleError(error, res);
  }
});

app.post('/api/validar-orden', async (req, res) => {
  try {
    const { placa } = req.body;
    validatePlaca(placa);

    const orden = await db.obtenerOrdenPorPlaca(placa);
    if (!orden) {
      throw new AppError('Orden no encontrada', 404);
    }

    const revisiones = await db.obtenerRevisionesPorPlaca(placa);
    const completadas = revisiones.length;
    const porcentaje = Math.round((completadas / 110) * 100);

    const systemPrompt = prompts.construirSystemPromptValidator();

    const respuestaValidator = await llamarClaudeAPI(
      systemPrompt,
      [
        {
          role: 'user',
          content: `Validar orden ${placa}: ${completadas}/110 puntos completados (${porcentaje}%)`,
        },
      ],
      'validator'
    );

    logger.success('Order validated', { placa, porcentaje });

    res.json({
      status: 'ok',
      placa,
      porcentaje_completado: porcentaje,
      puntos_completados: completadas,
      validacion: respuestaValidator,
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

    const systemPrompt = prompts.construirSystemPromptReporter();
    const respuestaReporter = await llamarClaudeAPI(
      systemPrompt,
      [
        {
          role: 'user',
          content: `Generar reporte: ${JSON.stringify(stats)}`,
        },
      ],
      'reporter'
    );

    logger.success('Daily report generated');

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      estadisticas: stats,
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

      if (CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.PUBLIC_URL) {
        const webhookUrl = `${CONFIG.PUBLIC_URL}/webhook/telegram`;
        logger.info(`Registering Telegram webhook: ${webhookUrl}`);

        try {
          const response = await axios.post(
            `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/setWebhook`,
            { url: webhookUrl }
          );

          if (response.data.ok) {
            logger.success('Telegram webhook registered');
          } else {
            logger.error('Webhook registration error', { error: response.data.description });
          }
        } catch (error) {
          logger.error('Telegram setup error', { error: error.message });
        }
      }
    });
  } catch (error) {
    logger.error('Startup failed', { error: error.message });
    process.exit(1);
  }
}

start();

export default app;
