import { prompts } from './prompts.js';
import { logger } from './logger.js';
import { validatePlaca, validatePhoneNumber, validateMessage } from './validators.js';
import { llamarClaudeAPI } from './claude-client.js';
import { enviarMensajeTelegram } from './telegram-client.js';

export function extraerPlaca(texto) {
  const match = texto.match(/[A-Z]\d{3}[A-Z]{3}/);
  return match ? match[0] : null;
}

export async function procesarWhatsapp(db, payload, apiKey) {
  const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages || [];
  if (messages.length === 0) return;

  const mensaje = messages[0];
  const numeroCliente = mensaje.from;
  const textoCliente = mensaje.text.body;

  validatePhoneNumber(numeroCliente);
  validateMessage(textoCliente);

  logger.info(`WhatsApp: +${numeroCliente}`, { text: textoCliente.substring(0, 50) });

  const placa = extraerPlaca(textoCliente);
  let cliente = await db.obtenerClientePorNumero(numeroCliente);

  if (!cliente) {
    cliente = await db.crearCliente(numeroCliente, { nombre: 'Cliente', tipo: 'CLIENTE' });
    logger.success(`New client: +${numeroCliente}`);
  }

  let orden = null;
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

  const systemPrompt = prompts.construirSystemPromptCliente(placa, orden, cliente, historialTexto);
  const respuesta = await llamarClaudeAPI(
    apiKey,
    db,
    systemPrompt,
    [{ role: 'user', content: textoCliente }],
    'cliente',
    placa
  );

  if (placa && orden) {
    await db.guardarConversacion(placa, cliente.id, 'CLIENTE', textoCliente, respuesta);
  }

  // Gap conocido (pre-existente): no hay integración de envío saliente de WhatsApp
  // (Graph API send-message). El webhook ya respondió 200 antes de este punto, así
  // que esta respuesta no llega al cliente hasta que se implemente el envío saliente.
  logger.warn('Respuesta de Claude generada pero no enviada a WhatsApp (envío saliente no implementado)', {
    placa,
    respuesta: respuesta.substring(0, 50),
  });
}

export async function procesarTelegramMecanico(db, payload, botToken, apiKey) {
  const { message } = payload;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const telegram_id = message.from.id;
  const texto = message.text;
  const userName = message.from?.first_name || 'Mecánico';

  logger.info(`Mechanic: ${userName} (${telegram_id})`, { text: texto.substring(0, 50) });

  const placa = extraerPlaca(texto);
  if (!placa) {
    await enviarMensajeTelegram(botToken, chatId, '¿Cuál es la placa del vehículo que estás inspeccionando?');
    return;
  }

  validatePlaca(placa);
  const orden = await db.obtenerOrdenPorPlaca(placa);
  if (!orden) {
    await enviarMensajeTelegram(botToken, chatId, `No encontré ninguna orden con placa ${placa}.`);
    return;
  }

  const revisiones = await db.obtenerRevisionesPorPlaca(placa);
  const punto_actual = revisiones.length + 1;

  const systemPrompt = prompts.construirSystemPromptMecanico(placa, orden.tipo_auto, punto_actual, texto);
  const respuesta = await llamarClaudeAPI(
    apiKey,
    db,
    systemPrompt,
    [{ role: 'user', content: texto }],
    'mecanico',
    placa
  );

  await db.guardarRevision(placa, telegram_id, punto_actual, texto);
  await enviarMensajeTelegram(botToken, chatId, respuesta);

  logger.success('Mechanic response sent', { placa, punto_actual });
}

export async function procesarTelegramTramitador(db, payload, botToken, apiKey) {
  const { message } = payload;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const telegram_id = message.from.id;
  const texto = message.text;
  const userName = message.from?.first_name || 'Tramitador';

  logger.info(`Processor: ${userName} (${telegram_id})`, { text: texto.substring(0, 50) });

  const placa = extraerPlaca(texto);
  if (!placa) {
    await enviarMensajeTelegram(botToken, chatId, '¿Cuál es la placa del vehículo cuyo trámite estás gestionando?');
    return;
  }

  validatePlaca(placa);
  const orden = await db.obtenerOrdenPorPlaca(placa);
  if (!orden) {
    await enviarMensajeTelegram(botToken, chatId, `No encontré ninguna orden con placa ${placa}.`);
    return;
  }

  const cliente = await db.obtenerClientePorNumero(orden.cliente_id);
  const etapa = orden.status;

  const systemPrompt = prompts.construirSystemPromptTramitador(placa, cliente, etapa, { SAT: 'Pendiente' });
  const respuesta = await llamarClaudeAPI(
    apiKey,
    db,
    systemPrompt,
    [{ role: 'user', content: texto }],
    'tramitador',
    placa
  );

  await enviarMensajeTelegram(botToken, chatId, respuesta);

  logger.success('Processor response sent', { placa, etapa });
}
