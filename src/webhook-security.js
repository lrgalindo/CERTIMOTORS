import crypto from 'node:crypto';
import { logger } from './logger.js';

let avisoWhatsappSinSecreto = false;

// Meta firma el body crudo con HMAC SHA-256 usando el App Secret y lo manda en
// X-Hub-Signature-256 como "sha256=<hex>". Si no hay APP_SECRET configurado no
// podemos verificar nada — se deja pasar pero se avisa una sola vez (modo dev).
export function verificarFirmaWhatsapp(rawBody, signatureHeader, appSecret) {
  if (!appSecret) {
    if (!avisoWhatsappSinSecreto) {
      logger.warn('WHATSAPP_APP_SECRET no configurado: firma de webhook sin verificar');
      avisoWhatsappSinSecreto = true;
    }
    return true;
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const esperada = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const recibida = signatureHeader.slice('sha256='.length);

  const bufEsperada = Buffer.from(esperada, 'hex');
  const bufRecibida = Buffer.from(recibida, 'hex');
  if (bufEsperada.length !== bufRecibida.length) return false;

  return crypto.timingSafeEqual(bufEsperada, bufRecibida);
}

// Telegram no firma el body; en su lugar, setWebhook acepta un secret_token que
// luego reenvía en el header X-Telegram-Bot-Api-Secret-Token en cada update.
export function verificarSecretoTelegram(secretHeader, secretoEsperado) {
  if (!secretoEsperado) return true;
  if (!secretHeader) return false;

  const bufEsperado = Buffer.from(secretoEsperado);
  const bufRecibido = Buffer.from(secretHeader);
  if (bufEsperado.length !== bufRecibido.length) return false;

  return crypto.timingSafeEqual(bufEsperado, bufRecibido);
}
