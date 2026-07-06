import crypto from 'crypto';
import axios from 'axios';
import { logger } from './logger.js';
import { AppError } from './errors.js';

export const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '8289807493';

async function telegramPost(botToken, method, body) {
  const resp = await axios.post(`https://api.telegram.org/bot${botToken}/${method}`, body);
  return resp.data;
}

export async function notificarAprobacionAdmin(placa, pdfUrl, orden, resumen = {}) {
  const botToken = process.env.TELEGRAM_MECANICO_BOT_TOKEN;
  if (!botToken) {
    logger.warn('TELEGRAM_MECANICO_BOT_TOKEN no configurado, saltando notificación admin', { placa });
    return;
  }

  const servicio = orden.servicio === 'FULL' ? 'FULL Q1,200' : 'BÁSICO Q550';
  const { criticos = 0 } = resumen;
  const alertaCriticos =
    criticos > 0 ? `\n⚠️ *${criticos} hallazgo(s) crítico(s)*` : '\n✅ Sin hallazgos críticos';

  const texto =
    `📄 *Certificado listo para revisión*\n\n` +
    `Placa: \`${placa}\`\n` +
    `Servicio: ${servicio}${alertaCriticos}\n\n` +
    `[Ver PDF](${pdfUrl})`;

  try {
    await telegramPost(botToken, 'sendMessage', {
      chat_id: ADMIN_CHAT_ID,
      text: texto,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Aprobar y enviar al cliente', callback_data: `aprobar:${placa}` },
          { text: '✏️ Necesita corrección', callback_data: `correccion:${placa}` },
        ]],
      },
    });
    logger.success('Notificación de aprobación enviada a admin', { placa });
  } catch (error) {
    logger.error('Error enviando notificación de aprobación a admin', { placa, error: error.message });
  }
}

export async function procesarCallbackAdmin(db, payload, botToken) {
  const { callback_query: cq } = payload;
  if (!cq) return;

  // Authorization: only the configured admin may trigger certificate actions.
  if (String(cq.from?.id) !== String(ADMIN_CHAT_ID)) {
    logger.warn('procesarCallbackAdmin: callback de usuario no autorizado', {
      from: cq.from?.id,
      esperado: ADMIN_CHAT_ID,
    });
    try {
      await telegramPost(botToken, 'answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'No autorizado',
        show_alert: true,
      });
    } catch (_) {}
    return;
  }

  const chatId = cq.from.id;

  try {
    await telegramPost(botToken, 'answerCallbackQuery', { callback_query_id: cq.id });
  } catch (_) {}

  if (!cq.data) return;
  const colonIndex = cq.data.indexOf(':');
  if (colonIndex === -1) return;
  const accion = cq.data.slice(0, colonIndex);
  const placa = cq.data.slice(colonIndex + 1);

  if (accion === 'aprobar') {
    await manejarAprobacion(db, botToken, chatId, placa);
  } else if (accion === 'correccion') {
    await manejarCorreccion(db, botToken, chatId, placa);
  }
}

async function manejarAprobacion(db, botToken, chatId, placa) {
  try {
    const orden = await db.obtenerOrdenPorPlaca(placa);
    if (!orden?.certificado_url) {
      await telegramPost(botToken, 'sendMessage', {
        chat_id: chatId,
        text: `❌ No encontré el PDF para la placa ${placa}. ¿Ya fue generado?`,
      });
      return;
    }

    await db.actualizarStatusOrden(placa, 'CERTIFICADO_APROBADO');
    await db.crearNotificacion(placa, 'CERTIFICADO_APROBADO', 'Aprobado por Rodrigo para envío al cliente');

    await enviarPdfWhatsapp(db, placa, orden);

    await telegramPost(botToken, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Certificado de *${placa}* aprobado y enviado al cliente por WhatsApp.`,
      parse_mode: 'Markdown',
    });
    logger.success('PDF aprobado y enviado al cliente', { placa });
  } catch (error) {
    logger.error('Error procesando aprobación de PDF', { placa, error: error.message });
    try {
      await telegramPost(botToken, 'sendMessage', {
        chat_id: chatId,
        text: `❌ Error al aprobar *${placa}*: ${error.message}`,
        parse_mode: 'Markdown',
      });
    } catch (_) {}
  }
}

async function manejarCorreccion(db, botToken, chatId, placa) {
  await db.crearNotificacion(placa, 'CORRECCION_PENDIENTE', 'Rodrigo solicitó corrección al certificado');
  await telegramPost(botToken, 'sendMessage', {
    chat_id: chatId,
    text:
      `✏️ Placa *${placa}* marcada para corrección.\n\n` +
      `Escribí los cambios necesarios y los registraré en el sistema.`,
    parse_mode: 'Markdown',
  });
  logger.info('Corrección solicitada por admin', { placa });
}

// Mapea el veredicto del validator (notificación CERTIFICADO_VALIDACION, ver
// prompts.js: "✅ APROBADO PARA CERTIFICADO / ⚠️ APROBADO CON IMPEDIMENTO /
// ❌ RECHAZADO") a un caption breve en tono de asesor. Sin veredicto → genérico.
export function captionSegunVeredicto(veredicto, placa, nombreCliente = '') {
  if (veredicto?.includes('APROBADO CON IMPEDIMENTO')) {
    return `Tu certificado CERTIMOTORS de ${placa} está listo${nombreCliente}: aprobado con observaciones. El detalle viene dentro del documento.`;
  }
  if (veredicto?.includes('APROBADO PARA CERTIFICADO')) {
    return `Tu certificado CERTIMOTORS de ${placa} está listo${nombreCliente}: inspección aprobada. Guardalo como respaldo de tu vehículo.`;
  }
  if (veredicto?.includes('RECHAZADO')) {
    return `Tu informe CERTIMOTORS de ${placa} está listo${nombreCliente}. El vehículo no fue aprobado esta vez; el detalle está en el documento.`;
  }
  return `🎉 Tu certificado CERTIMOTORS está listo${nombreCliente}. Guárdalo como respaldo de la inspección de tu vehículo.`;
}

async function enviarPdfWhatsapp(db, placa, orden) {
  const cliente = await db.obtenerClientePorId(orden.cliente_id);
  if (!cliente?.numero_telefono) {
    logger.warn('Sin número de teléfono del cliente para enviar PDF', { placa });
    return;
  }

  // El caption confirma el veredicto si quedó registrado; si la lectura falla,
  // se envía igual el PDF con el caption genérico.
  let veredicto = null;
  try {
    const notifs = await db.obtenerNotificacionesPorPlacaYTipos(placa, ['CERTIFICADO_VALIDACION']);
    veredicto = notifs[0]?.mensaje || null;
  } catch (error) {
    logger.warn('No se pudo leer el veredicto de validación para el caption', { placa, error: error.message });
  }

  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    logger.warn('WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID no configurados, omitiendo envío de PDF', { placa });
    return;
  }

  const nombreCliente = cliente.nombre && cliente.nombre !== 'Cliente' ? `, ${cliente.nombre}` : '';
  await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to: cliente.numero_telefono,
      type: 'document',
      document: {
        link: orden.certificado_url,
        filename: `Certificado_${placa}_CERTIMOTORS.pdf`,
        caption: captionSegunVeredicto(veredicto, placa, nombreCliente),
      },
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  logger.success('PDF enviado al cliente por WhatsApp', { placa, numero: cliente.numero_telefono });
}

// ─── Token-based approval API ────────────────────────────────────────────────
// Provides a DB-centric approval flow that doesn't depend on Telegram inline
// keyboards: generate a one-time token, store it, later exchange it for an
// approval or correction action. Complements the Telegram keyboard flow.

export async function notificarAdminParaAprobacion(db, placa, pdfBuffer) {
  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new AppError(`PDF vacío para placa ${placa}`, 422);
  }
  const token = crypto.randomBytes(24).toString('hex');
  await db.guardarTokenAprobacion(placa, token);
  await db.crearNotificacion(placa, 'APROBACION_PENDIENTE', `Token de aprobación generado: ${token.slice(0, 8)}...`);
  logger.info('Token de aprobación generado', { placa });
  return { token, placa };
}

export async function procesarCallbackAprobacion(db, token) {
  const placa = await db.obtenerPlacaPorToken(token);
  if (!placa) throw new AppError('Token inválido o ya utilizado', 401);
  await db.actualizarStatusOrden(placa, 'CERTIFICADO_APROBADO');
  await db.crearNotificacion(placa, 'CERTIFICADO_APROBADO', 'Aprobado por administrador vía token');
  await db.marcarTokenUsado(token);
  logger.success('Certificado aprobado vía token', { placa });
  return { status: 'APROBADO', placa };
}

export async function procesarCallbackCorreccion(db, token, notas = '') {
  const placa = await db.obtenerPlacaPorToken(token);
  if (!placa) throw new AppError('Token inválido o ya utilizado', 401);
  await db.actualizarStatusOrden(placa, 'NECESITA_CORRECCION');
  await db.crearNotificacion(placa, 'NECESITA_CORRECCION', notas);
  logger.info('Corrección solicitada vía token', { placa });
  return { status: 'NECESITA_CORRECCION', placa };
}
