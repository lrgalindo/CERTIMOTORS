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
import { estadoInicial, actualizarEstado, extraerDatos, contextoParaPrompt } from './estado-conversacion.js';

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

// /start y demás comandos de Telegram no son texto de inspección/trámite: se
// responden con guía fija, sin pasar por Claude (un /start metido al flujo de
// extracción participó en el incidente de jobs huérfanos, jul 2026).
export function esComandoBot(message) {
  return Boolean(message?.entities?.some((e) => e.type === 'bot_command' && e.offset === 0));
}

// Persiste la foto del mecánico para el registro fotográfico del PDF v2.
// Best-effort: si la migración 008 no está aplicada o Storage falla, se loggea
// y la inspección sigue — la foto ya viajó a Claude para el análisis igual.
// `contentUser` es el array de bloques de construirContentConImagen.
async function guardarFotoInspeccionSegura(db, placa, contentUser, hallazgos, texto) {
  try {
    const bloqueImagen = Array.isArray(contentUser) && contentUser.find((b) => b.type === 'image');
    if (!bloqueImagen) return;

    // Solo hallazgos válidos (mismo criterio que guardarRevision): un punto
    // fuera de rango de Claude no debe terminar como referencia de la foto.
    const validos = hallazgos.filter(
      (h) => Number.isInteger(h.punto) && h.punto >= 1 && h.punto <= 110 && ESTADOS_HALLAZGO.includes(h.estado)
    );
    const relevante = validos.find((h) => h.estado === 'MAL') || validos.find((h) => h.estado === 'REGULAR') || validos[0];
    const caption = relevante?.nombre_punto || (texto || '').slice(0, 60) || 'Hallazgo';

    await db.asegurarBucketFotos();
    const buffer = Buffer.from(bloqueImagen.source.data, 'base64');
    const ruta = await db.subirFotoInspeccion(placa, buffer, bloqueImagen.source.media_type);
    await db.guardarFotoInspeccion({ placa, punto: relevante?.punto ?? null, caption, storagePath: ruta });
    logger.success('Foto de inspección guardada', { placa, caption });
  } catch (error) {
    logger.warn('No se pudo guardar la foto de inspección (¿migración 008 pendiente?)', { placa, error: error.message });
  }
}

// Último mensaje que el bot le mandó a cada mecánico. Sin esto, cada mensaje
// es un turno aislado y una respuesta como "No" a la pregunta de confirmación
// de cierre no tiene referente (incidente 9 Jul 2026: el bot la trató como
// hallazgo ambiguo). ponytail: en memoria — un solo worker; si el proceso
// reinicia a mitad de conversación, degrada al comportamiento anterior.
const ultimaRespuestaBotMecanico = new Map();

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
      const tgBase = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';
      const fileResp = await axios.get(`${tgBase}/bot${botToken}/getFile`, {
        params: { file_id: mediaId },
      });
      const filePath = fileResp.data.result.file_path;
      const { base64, contentType } = await descargarImagenBase64(
        `${tgBase}/file/bot${botToken}/${filePath}`
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

// Escalación a humano: avisa al admin por Telegram con el contexto mínimo para
// retomar la conversación. Best-effort: nunca rompe la respuesta al cliente.
// `ultimosMensajes` son filas de obtenerConversacionesPorCliente (desc).
export async function enviarEscalacionAdmin(numeroCliente, ultimosMensajes = [], placa = null) {
  try {
    const contexto = ultimosMensajes
      .slice(0, 3)
      .reverse()
      .map((c) => `Cliente: ${c.mensaje_entrada}\nAsesor: ${c.respuesta_ia}`)
      .join('\n');
    const texto =
      `🙋 Cliente pide hablar con un humano\n\n` +
      `Número: +${numeroCliente}\n` +
      (placa ? `Placa: ${placa}\n` : '') +
      (contexto ? `\nÚltimos mensajes:\n${contexto}` : '\n(Sin historial previo)');
    // enviarMensajeTelegram usa parse_mode HTML: escapar el texto del cliente
    // para que un "<" en su mensaje no invalide la alerta de escalación.
    const textoSeguro = texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await enviarMensajeTelegram(process.env.TELEGRAM_MECANICO_BOT_TOKEN, ADMIN_CHAT_ID, textoSeguro);
  } catch (error) {
    logger.error('No se pudo enviar la escalación al admin', { numeroCliente, error: error.message });
  }
}

// Aviso de hito al cliente por WhatsApp. Best-effort: si falla la búsqueda del
// cliente o el envío, se loggea y el flujo sigue — nunca rompe el job.
async function notificarHitoCliente(db, clienteId, placa, mensaje) {
  try {
    const cliente = await db.obtenerClientePorId(clienteId);
    if (!cliente?.numero_telefono) return;
    await enviarWhatsapp(cliente.numero_telefono, mensajeTexto(mensaje));
    logger.success('Hito notificado al cliente por WhatsApp', { placa });
  } catch (error) {
    logger.error('No se pudo notificar hito al cliente', { placa, error: error.message });
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

// Persistencia best-effort del estado: si la migración 009 no está aplicada,
// se loggea y la conversación sigue (el estado simplemente no persiste).
async function guardarEstadoSeguro(db, clienteId, estado) {
  try {
    await db.actualizarEstadoConversacion(clienteId, estado);
  } catch (error) {
    logger.warn('No se pudo persistir estado_conversacion (¿migración 009 pendiente?)', { clienteId, error: error.message });
  }
}

export async function procesarWhatsapp(db, payload, apiKey) {
  const t0 = Date.now();
  const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages || [];
  if (messages.length === 0) return;

  const mensaje = messages[0];
  const numeroCliente = mensaje.from;
  const tipoMensaje = mensaje.type;

  validatePhoneNumber(numeroCliente);

  const bloqueados = (process.env.NUMEROS_BLOQUEADOS || '').split(',').map(n => n.trim()).filter(Boolean);
  if (bloqueados.includes(numeroCliente)) {
    logger.info(`WhatsApp: número bloqueado, ignorando`, { numeroCliente });
    return;
  }

  // Solo las reacciones se ignoran en silencio; a todo lo demás el asesor responde.
  if (tipoMensaje === 'reaction') {
    logger.info(`WhatsApp: reacción recibida, ignorando`);
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
        // Tocar un botón es elección explícita: monto confirmado por definición.
        const estadoBoton = actualizarEstado(cliente.estado_conversacion || estadoInicial(), {
          plan_elegido: servicioBoton,
          monto_confirmado: true,
          placa: orden.placa,
        });
        await guardarEstadoSeguro(db, cliente.id, estadoBoton);
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
  } else if (tipoMensaje === 'audio') {
    // ponytail: sin transcripción todavía — el asesor pide que escriba
    textoCliente = '[nota de voz]';
    contentUser = 'El cliente envió una nota de voz que no podés escuchar.';
    logger.info(`WhatsApp audio: +${numeroCliente}`);
  } else {
    // video, document, sticker, location, etc.
    textoCliente = `[${tipoMensaje}]`;
    contentUser = `El cliente envió un mensaje de tipo "${tipoMensaje}" que no podés ver.`;
    logger.info(`WhatsApp ${tipoMensaje}: +${numeroCliente}`);
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

  // Estado explícito de la conversación: el código decide etapa y faltantes;
  // el agente solo recibe el contexto y conversa.
  const estadoPrevio = actualizarEstado(cliente.estado_conversacion || estadoInicial(), placa ? { placa } : {});

  const systemPrompt = prompts.construirSystemPromptCliente(placa, orden, cliente, historialTexto, {
    ordenAjena,
    contextoEstado: contextoParaPrompt(estadoPrevio),
  });
  const respuestaCruda = await llamarClaudeAPI(
    apiKey,
    db,
    systemPrompt,
    [{ role: 'user', content: contentUser }],
    'cliente',
    placa
  );

  const { texto: sinMarcadores, servicio: servicioElegido, escalar } = extraerMarcadores(respuestaCruda);
  const { texto: respuestaLimpia, datos } = extraerDatos(sinMarcadores);
  let respuestaFinal = respuestaLimpia;

  // [SERVICIO:X] es la elección explícita del cliente: fija plan y monto.
  if (servicioElegido) {
    datos.plan_elegido = servicioElegido;
    datos.monto_confirmado = true;
  }
  const estado = actualizarEstado(estadoPrevio, datos);
  await guardarEstadoSeguro(db, cliente.id, estado);

  // Elección (o cambio) de servicio, solo antes del pago. El link de pago solo
  // existe con monto_confirmado — la elección explícita es lo que lo confirma.
  const puedeElegir = orden && ['INICIADA', 'SERVICIO_PRESENTADO', 'ESPERANDO_PAGO'].includes(orden.status);
  if (servicioElegido && puedeElegir && estado.campos.monto_confirmado) {
    const url = await confirmarServicio(db, orden.placa, servicioElegido);
    respuestaFinal = `${respuestaLimpia}\n\nPodés pagar aquí: ${url}`;
    logger.success('Servicio elegido por texto', { placa: orden.placa, servicio: servicioElegido });
  }

  if (escalar) {
    const historialEscalacion = await db.obtenerConversacionesPorCliente(cliente.id, 3);
    await enviarEscalacionAdmin(numeroCliente, historialEscalacion, placa);
    logger.warn('Agente solicitó escalación a humano', { numeroCliente, placa });
  }

  await guardarConversacionSegura(db, placa, cliente.id, textoCliente, respuestaFinal);

  // Botones BÁSICO/FULL acompañan la respuesta solo mientras no haya elección.
  const mostrarBotones =
    orden && !servicioElegido && ['INICIADA', 'SERVICIO_PRESENTADO'].includes(orden.status);
  await enviarWhatsapp(numeroCliente, mostrarBotones ? mensajeBotonesServicio(respuestaFinal) : mensajeTexto(respuestaFinal));
  logger.success('Respuesta enviada al cliente por WhatsApp', { numeroCliente });
  // Observabilidad de latencia por etapa (solo medición, sin optimizar nada).
  logger.info('Latencia WhatsApp', { ms: Date.now() - t0, etapa: estado.etapa });
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

  // Idempotencia: Recurrente/Svix reintenta y puede replayar dentro de la
  // ventana anti-replay. Si la orden ya avanzó más allá del pago, no repetir
  // el cambio de estado ni los avisos al cliente y al admin.
  if (!['INICIADA', 'SERVICIO_PRESENTADO', 'ESPERANDO_PAGO'].includes(orden.status)) {
    logger.info('Webhook Recurrente ignorado (pago ya procesado)', { placa, status: orden.status });
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

  if (esComandoBot(message)) {
    await enviarMensajeTelegram(
      botToken,
      chatId,
      `Hola ${userName} 👋 Soy el asistente de inspecciones de CERTIMOTORS.\n\nDecime la placa del vehículo que vas a inspeccionar y después mandame tus hallazgos (texto o foto).`
    );
    return;
  }

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

  const systemPrompt = prompts.construirSystemPromptMecanico(
    placa,
    orden.tipo_auto,
    puntosCompletados,
    ultimosHallazgos,
    ultimaRespuestaBotMecanico.get(telegram_id) || null
  );
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

  if (hasPhoto) {
    await guardarFotoInspeccionSegura(db, placa, contentUser, hallazgos, texto);
  }

  if (inspeccionCompleta) {
    await db.actualizarDatosOrden(placa, { inspector_nombre: userName });
    await db.actualizarStatusOrden(placa, 'INSPECCION_COMPLETA');
    await db.crearNotificacion(placa, 'INSPECCION_COMPLETA', `Inspección completada por ${userName}`);

    // Idempotencia: `orden` trae el status previo a esta actualización; si ya
    // estaba completa (reintento de job o mensaje repetido), no se re-avisa.
    if (orden.status !== 'INSPECCION_COMPLETA') {
      await notificarHitoCliente(
        db,
        orden.cliente_id,
        placa,
        `Tu inspección de ${placa} está lista. Estamos preparando tu certificado.`
      );
    }

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

  // Al cerrar una inspección, el contexto de esa conversación ya no aplica a
  // la siguiente placa — se descarta en vez de arrastrarlo.
  if (inspeccionCompleta) ultimaRespuestaBotMecanico.delete(telegram_id);
  else ultimaRespuestaBotMecanico.set(telegram_id, respuesta);
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

  if (esComandoBot(message)) {
    await enviarMensajeTelegram(
      botToken,
      chatId,
      `Hola ${userName} 👋 Soy el asistente de trámites de CERTIMOTORS.\n\nDecime la placa del vehículo y contame el avance del trámite (impuesto, calcomanía, multas, gravámenes).`
    );
    return;
  }

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

    // Solo el servicio FULL incluye verificaciones legales; mismo guard de
    // idempotencia que en la inspección (status previo en `orden`).
    if (orden.servicio === 'FULL' && orden.status !== 'TRAMITE_COMPLETO') {
      await notificarHitoCliente(
        db,
        orden.cliente_id,
        placa,
        `Las verificaciones legales de ${placa} están listas. Generando tu certificado completo.`
      );
    }
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
