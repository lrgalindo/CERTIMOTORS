import axios from 'axios';
import { logger } from './logger.js';

const CONFIG = {
  TELEGRAM_MECANICO_BOT_TOKEN:   process.env.TELEGRAM_MECANICO_BOT_TOKEN,
  TELEGRAM_TRAMITADOR_BOT_TOKEN: process.env.TELEGRAM_TRAMITADOR_BOT_TOKEN,
  TELEGRAM_MECANICO_CHAT_ID:     process.env.TELEGRAM_MECANICO_CHAT_ID,
  TELEGRAM_TRAMITADOR_CHAT_ID:   process.env.TELEGRAM_TRAMITADOR_CHAT_ID,
};

export function mensajeMecanico(orden, cliente) {
  const icono = orden.servicio === 'SCANNER' ? '🔍' : '🚗';
  const tarea = {
    SCANNER:  'Solo escaneo OBD-II.',
    ESTANDAR: 'Inspección técnica completa — 110 puntos.',
    FULL:     'Inspección 110 puntos + verificación legal.\nEl tramitador también fue notificado.',
  }[orden.servicio] || '';
  const fecha = orden.fecha_preferida
    ? new Date(orden.fecha_preferida).toLocaleDateString('es-GT')
    : 'Por confirmar';
  const tel = cliente?.numero_telefono ? `+${cliente.numero_telefono}` : 'N/D';

  return `${icono} <b>NUEVA ORDEN · ${orden.servicio}</b>

<b>Placa:</b> <code>${orden.placa}</code>
<b>Cliente:</b> ${orden.nombre_cliente || 'N/D'}
<b>Tel:</b> ${tel}
<b>Zona:</b> ${orden.zona || 'N/D'}
<b>Fecha preferida:</b> ${fecha}

${tarea}
<i>Registra la placa en el bot para iniciar.</i>`;
}

export function mensajeTramitador(orden, cliente) {
  const tel = cliente?.numero_telefono ? `+${cliente.numero_telefono}` : 'N/D';
  return `📋 <b>NUEVA ORDEN · FULL (TRÁMITE)</b>

<b>Placa:</b> <code>${orden.placa}</code>
<b>Cliente:</b> ${orden.nombre_cliente || 'N/D'}
<b>Tel:</b> ${tel}

Verificaciones: impuesto circulación, calcomanía, multas, gravámenes.
<i>Registra la placa en tu bot cuando el mecánico confirme la inspección.</i>`;
}

// Envía el mensaje de Telegram y LANZA en caso de fallo (a diferencia de
// enviarMensajeTelegram, que swallow errors). Esta variante es la correcta
// para ser llamada desde un job de la cola — el error propaga para que el
// worker marque el job como fallido y lo reintente con backoff.
// Si el chat_id no está configurado (sandbox), retorna sin hacer nada.
async function enviarTelegram(botToken, chatId, texto) {
  if (!botToken || !chatId) return;
  await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    chat_id: chatId,
    text: texto,
    parse_mode: 'HTML',
  });
}

// Notifica al mecánico y (si FULL y chat_id configurado) al tramitador.
//
// Retorna true si el mecánico fue notificado (al menos) — el caller solo debe
// llamar a marcarOrdenNotificada cuando esto sea true.
// Retorna false si falta config del mecánico — el caller NO debe marcar
// notificado_at; la orden quedará visible en la query de reconciliación.
// Lanza si el envío falla por red/API — el worker reintentará con backoff.
export async function notificarEquipo(orden, cliente) {
  if (!CONFIG.TELEGRAM_MECANICO_BOT_TOKEN || !CONFIG.TELEGRAM_MECANICO_CHAT_ID) {
    logger.warn('Notificación omitida: TELEGRAM_MECANICO_* no configurado (config faltante, no error de red)', {
      placa: orden.placa,
      servicio: orden.servicio,
    });
    return false;
  }

  await enviarTelegram(
    CONFIG.TELEGRAM_MECANICO_BOT_TOKEN,
    CONFIG.TELEGRAM_MECANICO_CHAT_ID,
    mensajeMecanico(orden, cliente)
  );

  if (orden.servicio === 'FULL') {
    if (CONFIG.TELEGRAM_TRAMITADOR_CHAT_ID) {
      await enviarTelegram(
        CONFIG.TELEGRAM_TRAMITADOR_BOT_TOKEN,
        CONFIG.TELEGRAM_TRAMITADOR_CHAT_ID,
        mensajeTramitador(orden, cliente)
      );
    } else {
      logger.warn('Tramitador no notificado: TELEGRAM_TRAMITADOR_CHAT_ID no configurado', {
        placa: orden.placa,
      });
    }
  }

  logger.info('Equipo notificado vía Telegram', { placa: orden.placa, servicio: orden.servicio });
  return true;
}
