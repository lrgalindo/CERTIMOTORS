import axios from 'axios';
import { prompts } from './prompts.js';
import { logger } from './logger.js';
import { validatePlaca, validatePhoneNumber, validateMessage } from './validators.js';
import { llamarClaudeAPI, llamarClaudeConTool } from './claude-client.js';
import { enviarMensajeTelegram } from './telegram-client.js';
import { TOOL_REGISTRAR_INSPECCION, TOOL_REGISTRAR_AVANCE_TRAMITE } from './tools.js';
import { validarOrden } from './validar-orden.js';
import { generarCertificado } from './pdf-generator.js';
import { notificarAprobacionAdmin, ADMIN_CHAT_ID } from './pdf-approval.js';

export const SERVICIOS = {
  BASICO: { etiqueta: 'BÁSICO', precio: 'Q550', cents: 55000 },
  FULL: { etiqueta: 'FULL', precio: 'Q1,200', cents: 120000 },
};

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

// Normaliza minúsculas, espacios y guiones: "p 123-abc" → "P123ABC".
export function extraerPlaca(texto) {
  const match = texto.toUpperCase().match(/\b([A-Z])[ -]?(\d{3})[ -]?([A-Z]{3})\b/);
  return match ? match[1] + match[2] + match[3] : null;
}

// Señales estructuradas que el agente cliente deja al final de su respuesta
// para que el código actúe (ver "SEÑALES PARA EL SISTEMA" en prompts.js).
export function extraerMarcadores(respuesta) {
  const servicio = respuesta.match(/\[SERVICIO:(BASICO|FULL)\]/)?.[1] || null;
  const escalar = respuesta.includes('[ESCALAR]');
  const texto = respuesta.replace(/\s*\[(?:SERVICIO:(?:BASICO|FULL)|ESCALAR)\]/g, '').trim();
  return { texto, servicio, escalar };
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

async function enviarWhatsapp(numero, cuerpo) {
  const graphBase = process.env.WHATSAPP_GRAPH_API_URL || 'https://graph.facebook.com';
  await axios.post(
    `${graphBase}/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to: numero, ...cuerpo },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

const mensajeTexto = (body) => ({ type: 'text', text: { body } });

// Botones nativos para la única decisión estructurada del flujo: BÁSICO vs FULL.
// El body es el texto del asesor (Claude); límite de la Cloud API: 1024 chars.
const mensajeBotonesServicio = (body) => ({
  type: 'interactive',
  interactive: {
    type: 'button',
    body: { text: body.slice(0, 1024) },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'servicio_BASICO', title: 'BÁSICO — Q550' } },
        { type: 'reply', reply: { id: 'servicio_FULL', title: 'FULL — Q1,200' } },
      ],
    },
  },
});

// El historial no debe tumbar la respuesta al cliente: si el insert falla
// (p.ej. migración 006 sin aplicar y placa NULL), se loggea y se sigue.
async function guardarConversacionSegura(db, placa, clienteId, entrada, respuesta) {
  try {
    await db.guardarConversacion(placa || null, clienteId, 'CLIENTE', entrada, respuesta);
  } catch (error) {
    logger.error('No se pudo guardar la conversación', { placa, error: error.message });
  }
}

export async function crearCheckoutRecurrente(placa, servicio) {
  const svc = SERVICIOS[servicio];
  const secretKey = process.env.RECURRENTE_SECRET_KEY;
  const linkPlaceholder = 'https://pay.certimotors.com/pendiente';

  if (!secretKey) {
    logger.warn('RECURRENTE_SECRET_KEY no configurada, usando link de pago placeholder', { placa, servicio });
    return linkPlaceholder;
  }

  try {
    const base = process.env.RECURRENTE_API_URL || 'https://app.recurrente.com';
    const resp = await axios.post(
      `${base}/api/checkouts`,
      {
        items: [
          {
            name: `Certificación ${svc.etiqueta} — ${placa}`,
            amount_in_cents: svc.cents,
            currency: 'GTQ',
            quantity: 1,
          },
        ],
        metadata: { placa, servicio },
      },
      { headers: { 'X-SECRET-KEY': secretKey, 'Content-Type': 'application/json' } }
    );
    return resp.data?.checkout_url || linkPlaceholder;
  } catch (error) {
    logger.error('Error creando checkout de Recurrente, usando link placeholder', { placa, error: error.message });
    return linkPlaceholder;
  }
}

// Persiste la elección de servicio y devuelve el link de pago.
async function confirmarServicio(db, placa, servicio) {
  await db.actualizarDatosOrden(placa, { servicio });
  await db.actualizarStatusOrden(placa, 'ESPERANDO_PAGO');
  return crearCheckoutRecurrente(placa, servicio);
}

export async function procesarWhatsapp(db, payload, apiKey) {
  const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages || [];
  if (messages.length === 0) return;

  const mensaje = messages[0];
  const numeroCliente = mensaje.from;
  const tipoMensaje = mensaje.type;

  validatePhoneNumber(numeroCliente);

  if (!['interactive', 'image', 'text'].includes(tipoMensaje)) {
    logger.info(`WhatsApp: tipo de mensaje no soportado (${tipoMensaje}), ignorando`);
    return;
  }

  let cliente = await db.obtenerClientePorNumero(numeroCliente);
  if (!cliente) {
    cliente = await db.crearCliente(numeroCliente, { nombre: 'Cliente', tipo: 'CLIENTE' });
    logger.success(`New client: +${numeroCliente}`);
  }

  let textoCliente;
  let contentUser;

  if (tipoMensaje === 'interactive') {
    const boton = mensaje.interactive?.button_reply;
    const servicioBoton = boton?.id?.startsWith('servicio_') ? boton.id.slice('servicio_'.length) : null;

    // Botón BÁSICO/FULL: decisión estructurada — se resuelve sin Claude.
    if (SERVICIOS[servicioBoton]) {
      const orden = await db.obtenerUltimaOrdenPorCliente(cliente.id);
      if (orden) {
        const svc = SERVICIOS[servicioBoton];
        const url = await confirmarServicio(db, orden.placa, servicioBoton);
        const respuesta =
          `Perfecto, ${svc.etiqueta} (${svc.precio}) para tu ${orden.placa}. Podés pagar aquí: ${url}\n\n` +
          `En cuanto se confirme el pago arrancamos con la inspección.`;
        await guardarConversacionSegura(db, orden.placa, cliente.id, boton.title || svc.etiqueta, respuesta);
        await enviarWhatsapp(numeroCliente, mensajeTexto(respuesta));
        logger.success('Servicio elegido por botón', { placa: orden.placa, servicio: servicioBoton });
        return;
      }
    }

    // Botón desconocido o sin orden activa: el título sigue como texto normal.
    textoCliente = boton?.title || '';
    contentUser = textoCliente || 'El cliente presionó un botón';
    logger.info(`WhatsApp interactivo: +${numeroCliente}`, { boton: textoCliente });
  } else if (tipoMensaje === 'image') {
    textoCliente = mensaje.image?.caption || 'El cliente envió una imagen';
    logger.info(`WhatsApp imagen: +${numeroCliente}`, { caption: textoCliente.substring(0, 50) });
    contentUser = await construirContentConImagen(textoCliente, mensaje.image?.id, 'whatsapp', null);
  } else if (tipoMensaje === 'text') {
    textoCliente = mensaje.text?.body || '';
    validateMessage(textoCliente);
    logger.info(`WhatsApp: +${numeroCliente}`, { text: textoCliente.substring(0, 50) });
    contentUser = textoCliente;
  }

  // Contexto de orden: placa del mensaje, o la última orden del cliente si no
  // la repite (el caso normal a mitad de conversación).
  let placa = extraerPlaca(textoCliente);
  let orden = null;
  let ordenAjena = false;
  if (placa) {
    validatePlaca(placa);
    orden = await db.obtenerOrdenPorPlaca(placa);
    if (orden && orden.cliente_id !== cliente.id) {
      // Placa de otro cliente: no exponer nada de esa orden (el prompt instruye la negativa).
      ordenAjena = true;
      orden = null;
      placa = null;
    } else if (!orden) {
      orden = await db.crearOrden(placa, { cliente_id: cliente.id, tipo_auto: 'RODADO', status: 'SERVICIO_PRESENTADO' });
      logger.success(`New order: ${placa}`);
    }
  }
  if (!orden && !ordenAjena) {
    orden = await db.obtenerUltimaOrdenPorCliente(cliente.id);
    placa = orden?.placa || null;
  }

  const conversaciones = await db.obtenerConversacionesPorCliente(cliente.id);
  const historialTexto = [...conversaciones]
    .reverse()
    .map((c) => `Cliente: ${c.mensaje_entrada}\nAsesor: ${c.respuesta_ia}`)
    .join('\n');

  const systemPrompt = prompts.construirSystemPromptCliente(placa, orden, cliente, historialTexto, { ordenAjena });
  const respuestaCruda = await llamarClaudeAPI(
    apiKey,
    db,
    systemPrompt,
    [{ role: 'user', content: contentUser }],
    'cliente',
    placa
  );

  const { texto: respuestaLimpia, servicio: servicioElegido, escalar } = extraerMarcadores(respuestaCruda);
  let respuestaFinal = respuestaLimpia;

  // Elección (o cambio) de servicio detectada por el agente, solo antes del pago.
  const puedeElegir = orden && ['INICIADA', 'SERVICIO_PRESENTADO', 'ESPERANDO_PAGO'].includes(orden.status);
  if (servicioElegido && puedeElegir) {
    const url = await confirmarServicio(db, orden.placa, servicioElegido);
    respuestaFinal = `${respuestaLimpia}\n\nPodés pagar aquí: ${url}`;
    logger.success('Servicio elegido por texto', { placa: orden.placa, servicio: servicioElegido });
  }

  if (escalar) {
    // ponytail: bloque 3 conecta enviarEscalacionAdmin; por ahora queda registrado.
    logger.warn('Agente solicitó escalación a humano', { numeroCliente, placa });
  }

  await guardarConversacionSegura(db, placa, cliente.id, textoCliente, respuestaFinal);

  // Botones BÁSICO/FULL acompañan la respuesta solo mientras no haya elección.
  const mostrarBotones =
    orden && !servicioElegido && ['INICIADA', 'SERVICIO_PRESENTADO'].includes(orden.status);
  await enviarWhatsapp(numeroCliente, mostrarBotones ? mensajeBotonesServicio(respuestaFinal) : mensajeTexto(respuestaFinal));
  logger.success('Respuesta enviada al cliente por WhatsApp', { numeroCliente });
}

// Webhook de pago de Recurrente. Recurrente reintenta si respondemos non-2xx,
// así que solo lanzamos en errores transitorios (DB); los payloads sin placa o
// eventos que no son pago se ignoran con 200 para no generar reintentos inútiles.
export async function procesarPagoRecurrente(db, payload) {
  const tipoEvento = payload?.event_type || payload?.type || '';
  if (tipoEvento && !/paid|succeeded|completed/i.test(tipoEvento)) {
    logger.info('Webhook Recurrente ignorado (no es pago exitoso)', { tipoEvento });
    return { procesado: false };
  }

  const placa = payload?.checkout?.metadata?.placa || payload?.metadata?.placa || null;
  if (!placa) {
    logger.error('Webhook Recurrente sin placa en metadata', { tipoEvento });
    return { procesado: false };
  }

  const orden = await db.obtenerOrdenPorPlaca(placa);
  if (!orden) {
    logger.error('Pago recibido para orden inexistente', { placa });
    return { procesado: false };
  }

  await db.actualizarStatusOrden(placa, 'PAGO_CONFIRMADO');
  await db.crearNotificacion(placa, 'PAGO_CONFIRMADO', `Pago confirmado vía Recurrente (${orden.servicio || 'BASICO'})`);
  logger.success('Pago confirmado vía Recurrente', { placa });

  // Avisos best-effort: no revierten el pago si fallan.
  const cliente = await db.obtenerClientePorId(orden.cliente_id);
  if (cliente?.numero_telefono) {
    try {
      await enviarWhatsapp(
        cliente.numero_telefono,
        mensajeTexto(
          `¡Pago confirmado! Ya coordinamos la inspección de tu ${placa}. ` +
            `Normalmente está lista en 3–5 horas el mismo día — te avisamos en cuanto terminemos.`
        )
      );
    } catch (error) {
      logger.error('No se pudo avisar al cliente del pago confirmado', { placa, error: error.message });
    }
  }

  // ponytail: no hay registro de chat_id por mecánico — Rodrigo coordina la inspección.
  await enviarMensajeTelegram(
    process.env.TELEGRAM_MECANICO_BOT_TOKEN,
    ADMIN_CHAT_ID,
    `💰 Pago confirmado: ${placa} (${orden.servicio || 'BASICO'}). Coordinar inspección.`
  );

  return { procesado: true, placa };
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
        logger.error('Error generando certificado (servicio BASICO)', { placa, error: error.message });
      }
    }
  }

  await enviarMensajeTelegram(botToken, chatId, respuesta);
  logger.success('Mechanic response sent', { placa, hallazgos: hallazgos.length, inspeccionCompleta });
}

export async function procesarTelegramTramitador(db, payload, botToken, apiKey) {
  const { message } = payload;
  const hasPhoto = Boolean(message?.photo?.length);
  const hasText = Boolean(message?.text);
  if (!message || (!hasText && !hasPhoto)) return;

  const chatId = message.chat.id;
  const telegram_id = message.from.id;
  const texto = message.text || message.caption || (hasPhoto ? 'Foto de documento' : '');
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
