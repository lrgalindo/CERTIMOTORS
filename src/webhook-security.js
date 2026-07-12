import crypto from 'node:crypto';
import { logger } from './logger.js';

// Recurrente usa Svix para delivery de webhooks.
// Firmado como: "${svix-id}.${svix-timestamp}.${raw_body}"
// Secreto en formato "whsec_<base64>" — se decodifica el sufijo.
export function verificarFirmaRecurrente(rawBody, headers, signingSecret) {
  if (!signingSecret) {
    logger.warn('RECURRENTE_WEBHOOK_SECRET no configurado — webhook rechazado');
    return false;
  }

  const svixId        = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Prevención de replay: rechazar si el timestamp tiene más de 5 minutos
  const ahora = Math.floor(Date.now() / 1000);
  if (Math.abs(ahora - parseInt(svixTimestamp, 10)) > 300) {
    logger.warn('Recurrente webhook rechazado: timestamp fuera de ventana', { svixTimestamp });
    return false;
  }

  const secret = signingSecret.startsWith('whsec_')
    ? Buffer.from(signingSecret.slice('whsec_'.length), 'base64')
    : Buffer.from(signingSecret, 'base64');

  const firmado = `${svixId}.${svixTimestamp}.${rawBody.toString()}`;
  const calculada = crypto.createHmac('sha256', secret).update(firmado).digest('base64');

  // svix-signature puede tener múltiples firmas separadas por espacio ("v1,xxx v1,yyy")
  return svixSignature.split(' ').some(sig => {
    const sigBase64 = sig.startsWith('v1,') ? sig.slice('v1,'.length) : sig;
    try {
      const a = Buffer.from(calculada, 'base64');
      const b = Buffer.from(sigBase64, 'base64');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });
}

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
