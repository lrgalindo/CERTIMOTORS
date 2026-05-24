import express from 'express';
import axios from 'axios';
import compression from 'compression';
import dotenv from 'dotenv';
import * as db from './db.js';
import { prompts } from './prompts.js';

dotenv.config();

const app = express();
app.use(express.json());
app.use(compression());

const CONFIG = {
  PORT: process.env.PORT || 3000,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-opus-4-20250514',
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

function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${level.padEnd(7)}: ${msg}`);
}

async function llamarClaudeAPI(systemPrompt, messages) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: CONFIG.ANTHROPIC_MODEL,
        max_tokens: 1500,
        system: systemPrompt,
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
    
    log('DEBUG', `✅ Claude: ${tokens} tokens`);
    return texto;
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    log('ERROR', `❌ Claude API: ${errorMsg}`);
    throw error;
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
    model: CONFIG.ANTHROPIC_MODEL,
    timestamp: new Date().toISOString(),
    uptime: Math.round((new Date() - METRICS.startTime) / 1000),
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
    log('INFO', '✅ WhatsApp webhook validado');
  } else {
    res.status(403).send('Token inválido');
    log('ERROR', '❌ Token WhatsApp inválido');
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

    log('INFO', `📱 WhatsApp: +${numeroCliente} → "${textoCliente.substring(0, 50)}..."`);

    let placa = extraerPlaca(textoCliente);
    let cliente = await db.obtenerClientePorNumero(numeroCliente);
    let orden = null;

    if (!cliente) {
      cliente = await db.crearCliente(numeroCliente, { nombre: 'Cliente', tipo: 'CLIENTE' });
      log('INFO', `✅ Cliente nuevo: +${numeroCliente}`);
    }

    if (placa) {
      orden = await db.obtenerOrdenPorPlaca(placa);
      if (!orden) {
        orden = await db.crearOrden(placa, { cliente_id: cliente.id, tipo_auto: 'RODADO' });
        log('INFO', `✅ Orden nueva: ${placa}`);
      }
    }

    const historial = placa ? await db.obtenerConversacionesPorPlaca(placa) : [];
    const historialTexto = historial
      .slice(-3)
      .map((c) => `${c.tipo_usuario}: ${c.mensaje_entrada}`)
      .join('\n');

    const systemPrompt = prompts.construirSystemPromptCliente(placa, orden, cliente, historialTexto);

    const respuestaClaudeIA = await llamarClaudeAPI(systemPrompt, [
      { role: 'user', content: textoCliente },
    ]);

    if (placa && orden) {
      await db.guardarConversacion(placa, cliente.id, 'CLIENTE', textoCliente, respuestaClaudeIA);
    }

    log('INFO', `🤖 Claude: "${respuestaClaudeIA.substring(0, 50)}..."`);

    res.json({
      status: 'ok',
      respuesta: respuestaClaudeIA,
      placa: placa || null,
    });
  } catch (error) {
    METRICS.totalErrors++;
    log('ERROR', `WhatsApp webhook: ${error.message}`);
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

    log('INFO', `📱 Telegram: ${userName} (${telegram_id}) → "${texto.substring(0, 50)}..."`);

    let placa = extraerPlaca(texto);
    let punto_actual = 1;

    if (placa) {
      const orden = await db.obtenerOrdenPorPlaca(placa);
      if (orden) {
        const revisiones = await db.obtenerRevisionesPorPlaca(placa);
        punto_actual = revisiones.length + 1;
        log('INFO', `✅ Orden encontrada: ${placa}, punto ${punto_actual}`);
      }
    }

    const systemPrompt = placa
      ? prompts.construirSystemPromptMecanico(placa, 'RODADO', punto_actual, texto)
      : `Eres asistente de CERTIMOTORS. Responde amablemente en español.`;

    const respuesta = await llamarClaudeAPI(systemPrompt, [
      { role: 'user', content: texto },
    ]);

    if (placa) {
      await db.guardarRevision(placa, telegram_id, punto_actual, texto);
    }

    const token = CONFIG.TELEGRAM_BOT_TOKEN;
    if (token) {
      try {
        await axios.post(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            chat_id: chatId,
            text: respuesta,
            parse_mode: 'HTML'
          }
        );
        log('INFO', `✅ Mensaje enviado a Telegram (${chatId})`);
      } catch (error) {
        log('ERROR', `Error enviando a Telegram: ${error.message}`);
      }
    }

    res.status(200).json({ ok: true });

  } catch (error) {
    METRICS.totalErrors++;
    log('ERROR', `Telegram webhook: ${error.message}`);
    res.status(200).json({ ok: true });
  }
});

app.post('/webhook/telegram/mecanico', async (req, res) => {
  METRICS.totalRequests++;
  
  try {
    const { message, telegram_id, placa, punto_actual = 1 } = req.body;
    log('INFO', `🔧 Mecánico (${telegram_id}): punto ${punto_actual}`);

    const orden = await db.obtenerOrdenPorPlaca(placa);
    if (!orden) {
      return res.status(400).json({ error: 'Orden no encontrada' });
    }

    const systemPrompt = prompts.construirSystemPromptMecanico(
      placa,
      orden.tipo_auto,
      punto_actual,
      message
    );

    const respuestaMecanico = await llamarClaudeAPI(systemPrompt, [
      { role: 'user', content: message },
    ]);

    await db.guardarRevision(placa, telegram_id, punto_actual, message);

    log('INFO', `✅ Respuesta mecánico enviada`);

    res.json({
      status: 'ok',
      respuesta: respuestaMecanico,
      punto_actual: punto_actual + 1,
    });
  } catch (error) {
    METRICS.totalErrors++;
    log('ERROR', `Telegram mecánico: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/webhook/telegram/tramitador', async (req, res) => {
  METRICS.totalRequests++;
  
  try {
    const { message, telegram_id, placa, etapa = 'Documentación' } = req.body;
    log('INFO', `📋 Tramitador (${telegram_id}): ${etapa}`);

    const orden = await db.obtenerOrdenPorPlaca(placa);
    if (!orden) {
      return res.status(400).json({ error: 'Orden no encontrada' });
    }

    const cliente = await db.obtenerClientePorNumero(orden.cliente_id);

    const systemPrompt = prompts.construirSystemPromptTramitador(
      placa,
      cliente,
      etapa,
      { SAT: 'Pendiente' }
    );

    const respuestaTramitador = await llamarClaudeAPI(systemPrompt, [
      { role: 'user', content: message },
    ]);

    log('INFO', `✅ Respuesta tramitador enviada`);

    res.json({
      status: 'ok',
      respuesta: respuestaTramitador,
      etapa_actual: etapa,
    });
  } catch (error) {
    METRICS.totalErrors++;
    log('ERROR', `Telegram tramitador: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/validar-orden', async (req, res) => {
  try {
    const { placa } = req.body;
    
    const orden = await db.obtenerOrdenPorPlaca(placa);
    if (!orden) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    const revisiones = await db.obtenerRevisionesPorPlaca(placa);
    const completadas = revisiones.length;
    const porcentaje = Math.round((completadas / 110) * 100);

    const systemPrompt = prompts.construirSystemPromptValidator();
    
    const respuestaValidator = await llamarClaudeAPI(systemPrompt, [
      {
        role: 'user',
        content: `Validar orden ${placa}: ${completadas}/110 puntos completados (${porcentaje}%)`
      }
    ]);

    res.json({
      status: 'ok',
      placa,
      porcentaje_completado: porcentaje,
      puntos_completados: completadas,
      validacion: respuestaValidator,
    });
  } catch (error) {
    METRICS.totalErrors++;
    log('ERROR', `Validación de orden: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reporte-diario', async (req, res) => {
  try {
    const stats = await db.obtenerEstadisticas();
    
    const systemPrompt = prompts.construirSystemPromptReporter();
    const respuestaReporter = await llamarClaudeAPI(systemPrompt, [
      {
        role: 'user',
        content: `Generar reporte: ${JSON.stringify(stats)}`
      }
    ]);

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      estadisticas: stats,
      reporte: respuestaReporter,
    });
  } catch (error) {
    METRICS.totalErrors++;
    log('ERROR', `Reporte diario: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

async function start() {
  try {
    await db.initDB();

    app.listen(CONFIG.PORT, async () => {
      log('INFO', `🚀 Backend escuchando en puerto ${CONFIG.PORT}`);
      log('INFO', `✅ CERTIMOTORS activado`);
      log('INFO', `✅ Claude API: ${CONFIG.ANTHROPIC_MODEL}`);
      log('INFO', `✅ Database: ${process.env.DATABASE_TYPE}`);
      log('INFO', `✅ Environment: ${CONFIG.NODE_ENV}`);
      log('INFO', `📍 http://localhost:${CONFIG.PORT}`);
      
      if (CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.PUBLIC_URL) {
        const webhookUrl = `${CONFIG.PUBLIC_URL}/webhook/telegram`;
        log('INFO', `📡 Registrando webhook Telegram: ${webhookUrl}`);
        
        try {
          const response = await axios.post(
            `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/setWebhook`,
            { url: webhookUrl }
          );
          
          if (response.data.ok) {
            log('INFO', `✅ Webhook Telegram registrado`);
          } else {
            log('ERROR', `❌ Webhook error: ${response.data.description}`);
          }
        } catch (error) {
          log('ERROR', `Setup Telegram error: ${error.message}`);
        }
      }
    });
  } catch (error) {
    log('ERROR', `Startup failed: ${error.message}`);
    process.exit(1);
  }
}

start();

export default app;
