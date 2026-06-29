import axios from 'axios';
import { prompts } from './prompts.js';
import { logger } from './logger.js';
import { validatePlaca, validatePhoneNumber, validateMessage } from './validators.js';
import { llamarClaudeAPI, llamarClaudeConTool } from './claude-client.js';
import { enviarMensajeTelegram } from './telegram-client.js';
import { TOOL_REGISTRAR_INSPECCION, TOOL_REGISTRAR_AVANCE_TRAMITE } from './tools.js';
import { validarOrden } from './validar-orden.js';
import { generarCertificado } from './pdf-generator.js';
import { notificarAprobacionAdmin } from './pdf-approval.js';

const ESTADOS_HALLAZGO = ['BIEN', 'REGULAR', 'MAL'];
const AREAS_TRAMITE = ['IMPUESTO_CIRCULACION', 'CALCOMANIA', 'MULTAS', 'GRAVAMENES'];
const ESTADOS_TRAMITE = [
  'SOLVENTE',
  'PENDIENTE',
  'VIGENTE',
  'VENCIDA',
  'SIN_MULTAS',
  'CON_MULTAS',
  'SIN_GRAVAMENES',
  'CON_GRAVAMENES',
  'NO_VERIFICADO',
];

export function extraerPlaca(texto) {
  const match = texto.match(/[A-Z]\d{3}[A-Z]{3}/);
  return match ? match[0] : null;
}

async function resolverPlacaActivaMecanico(db, mecanicoId) {
  const ultimaPlaca = await db.obtenerUltimaPlacaPorMecanico(mecanicoId);
  if (!ultimaPlaca) return null;
  const orden = await db.obtenerOrdenPorPlaca(ultimaPlaca);
  if (!orden || orden.status === 'INSPECCION_COMPLETA') return null;
  return ultimaPlaca;
}

// Downloads any URL as base64. On failure, the caller decides whether to continue.
async function descargarImagenBase64(url, headers = {}) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', headers });
  const base64 = Buffer.from(resp.data).toString('base64');
  const contentType = resp.headers['content-type']?.split(';')[0] || 'image/jpeg';
  return { base64, contentType };
}

// Returns an array of Anthropic content blocks: [image?, text].
// If the download fails, returns only the text block so the flow continues.
async function construirContentConImagen(texto, mediaId, canal, botToken) {
  const bloques = [];

  try {
    if (canal === 'whatsapp') {
      const infoResp = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      });
      const { base64, contentType } = await descargarImagenBase64(infoResp.data.url, {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      });
      bloques.push({ type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } });
    } else if (canal === 'telegram') {
      const fileResp = await axios.get(`https://api.telegram.org/bot${botToken}/getFile`, {
        params: { file_id: mediaId },
      });
      const filePath = fileResp.data.result.file_path;
      const { base64, contentType } = await descargarImagenBase64(
        `https://api.telegram.org/file/bot${botToken}/${filePath}`
      );
      bloques.push({ type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } });
    }
  } catch (err) {
    logger.warn('No se pudo descargar imagen, continuando sin ella', { canal, error: err.message });
  }

  bloques.push({ type: 'text', text: texto || 'Imagen adjunta' });
  return bloques;
}

export async function procesarWhatsapp(db, payload, apiKey) {
  const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages || [];
  if (messages.length === 0) return;

  const mensaje = messages[0];
  const numeroCliente = mensaje.from;
  const tipoMensaje = mensaje.type;

  validatePhoneNumber(numeroCliente);

  let textoCliente;
  let contentUser;

  if (tipoMensaje === 'image') {
    textoCliente = mensaje.image?.caption || 'El cliente envió una imagen';
    logger.info(`WhatsApp imagen: +${numeroCliente}`, { caption: textoCliente.substring(0, 50) });
    contentUser = await construirContentConImagen(textoCliente, mensaje.image?.id, 'whatsapp', null);
  } else if (tipoMensaje === 'text') {
    textoCliente = mensaje.text?.body || '';
    validateMessage(textoCliente);
    logger.info(`WhatsApp: +${numeroCliente}`, { text: textoCliente.substring(0, 50) });
    contentUser = textoCliente;
  } else {
    logger.info(`WhatsApp: tipo de mensaje no soportado (${tipoMensaje}), ignorando`);
    return;
  }

  let cliente = await db.obtenerClientePorNumero(numeroCliente);
  if (!cliente) {
    cliente = await db.crearCliente(numeroCliente, { nombre: 'Cliente', tipo: 'CLIENTE' });
    logger.success(`New client: +${numeroCliente}`);
  }

  const placa = extraerPlaca(textoCliente);
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
    [{ role: 'user', content: contentUser }],
    'cliente',
    placa
  );

  if (placa && orden) {
    await db.guardarConversacion(placa, cliente.id, 'CLIENTE', textoCliente, respuesta);
  }

  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: numeroCliente,
      type: 'text',
      text: { body: respuesta },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  logger.success('Respuesta enviada al cliente por WhatsApp', { numeroCliente });
}

export async function procesarTelegramMecanico(db, payload, botToken, apiKey) {
  const { message } = payload;
  const hasPhoto = Boolean(message?.photo?.length);
  const hasText = Boolean(message?.text);
  if (!message || (!hasText && !hasPhoto)) return;

  const chatId = message.chat.id;
  const telegram_id = message.from.id;
  const texto = message.text || message.caption || (hasPhoto ? 'Foto de hallazgo' : '');
  const userName = message.from?.first_name || 'Mecánico';

  logger.info(`Mechanic: ${userName} (${telegram_id})`, { text: texto.substring(0, 50) });

  const placa = extraerPlaca(texto) || (await resolverPlacaActivaMecanico(db, telegram_id));
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
  const puntosCompletados = new Set(revisiones.map((r) => r.punto_actual)).size;
  const ultimosHallazgos =
    revisiones
      .slice(-5)
      .map((r) => `Punto ${r.punto_actual}: ${r.respuesta}`)
      .join('\n') || null;

  let contentUser;
  if (hasPhoto) {
    const fotoMasGrande = message.photo[message.photo.length - 1];
    contentUser = await construirContentConImagen(texto, fotoMasGrande.file_id, 'telegram', botToken);
  } else {
    contentUser = texto;
  }

  const systemPrompt = prompts.construirSystemPromptMecanico(placa, orden.tipo_auto, puntosCompletados, ultimosHallazgos);
  const {
    hallazgos = [],
    inspeccion_completa: inspeccionCompleta = false,
    respuesta_mecanico: respuesta,
  } = await llamarClaudeConTool(
    apiKey,
    db,
    systemPrompt,
    [{ role: 'user', content: contentUser }],
    'mecanico',
    placa,
    TOOL_REGISTRAR_INSPECCION
  );

  for (const hallazgo of hallazgos) {
    if (
      !Number.isInteger(hallazgo.punto) ||
      hallazgo.punto < 1 ||
      hallazgo.punto > 110 ||
      !ESTADOS_HALLAZGO.includes(hallazgo.estado)
    ) {
      logger.warn('Hallazgo inválido descartado', { placa, hallazgo });
      continue;
    }
    const detalle = [hallazgo.estado, hallazgo.nombre_punto, hallazgo.observacion].filter(Boolean).join(' - ');
    await db.guardarRevision(placa, telegram_id, hallazgo.punto, detalle);
  }

  if (inspeccionCompleta) {
    await db.actualizarDatosOrden(placa, { inspector_nombre: userName });
    await db.actualizarStatusOrden(placa, 'INSPECCION_COMPLETA');
    await db.crearNotificacion(placa, 'INSPECCION_COMPLETA', `Inspección completada por ${userName}`);

    if (orden.servicio !== 'FULL') {
      try {
        const { url } = await generarCertificado(placa, db);
        await db.crearNotificacion(placa, 'CERTIFICADO_GENERADO', `Certificado generado: ${url}`);
        const criticos = hallazgos.filter((h) => h.estado === 'MAL').length;
        await notificarAprobacionAdmin(placa, url, orden, { criticos });
      } catch (error) {
        logger.error('Error generando certificado (servicio estándar)', { placa, error: error.message });
      }
    }
  }

  await enviarMensajeTelegram(botToken, chatId, respuesta);
  logger.success('Mechanic response sent', { placa, hallazgos: hallazgos.length, inspeccionCompleta });
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

  const cliente = await db.obtenerClientePorId(orden.cliente_id);
  const notificaciones = await db.obtenerNotificacionesPorPlaca(placa);
  const avancesPrevios =
    notificaciones
      .slice(0, 5)
      .map((n) => `${n.tipo}: ${n.mensaje}`)
      .join('\n') || null;

  const systemPrompt = prompts.construirSystemPromptTramitador(placa, cliente, avancesPrevios);
  const {
    actualizaciones = [],
    tramite_completo: tramiteCompleto = false,
    respuesta_tramitador: respuesta,
  } = await llamarClaudeConTool(
    apiKey,
    db,
    systemPrompt,
    [{ role: 'user', content: texto }],
    'tramitador',
    placa,
    TOOL_REGISTRAR_AVANCE_TRAMITE
  );

  for (const actualizacion of actualizaciones) {
    if (!AREAS_TRAMITE.includes(actualizacion.area) || !ESTADOS_TRAMITE.includes(actualizacion.estado)) {
      logger.warn('Actualización de trámite inválida descartada', { placa, actualizacion });
      continue;
    }
    const mensaje = [actualizacion.estado, actualizacion.detalle].filter(Boolean).join(': ');
    await db.crearNotificacion(placa, actualizacion.area, mensaje);
  }

  if (tramiteCompleto) {
    await db.actualizarStatusOrden(placa, 'TRAMITE_COMPLETO');
    await db.crearNotificacion(placa, 'TRAMITE_COMPLETO', `Trámite completado (reportado por ${userName})`);
    try {
      const { validacion } = await validarOrden(db, apiKey, placa);
      await db.crearNotificacion(placa, 'CERTIFICADO_VALIDACION', validacion);
    } catch (error) {
      logger.error('Error disparando validación de certificado', { placa, error: error.message });
    }
    try {
      const revisiones = await db.obtenerRevisionesPorPlaca(placa);
      const { url } = await generarCertificado(placa, db);
      await db.crearNotificacion(placa, 'CERTIFICADO_GENERADO', `Certificado generado: ${url}`);
      const criticos = revisiones.filter((r) => /^MAL/.test(r.respuesta || '')).length;
      await notificarAprobacionAdmin(placa, url, orden, { criticos });
    } catch (error) {
      logger.error('Error generando certificado (servicio full)', { placa, error: error.message });
    }
  }

  await enviarMensajeTelegram(botToken, chatId, respuesta);
  logger.success('Processor response sent', { placa, tramiteCompleto });
}
