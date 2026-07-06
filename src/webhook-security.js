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

const RECURRENTE_TOLERANCIA_SEGUNDOS = 300;

// Recurrente firma sus webhooks con el estándar Svix: HMAC-SHA256 en base64
// sobre "{svix-id}.{svix-timestamp}.{body}", con clave = base64 del secreto
// tras el prefijo "whsec_". El header svix-signature puede traer varias firmas
// "v1,<base64>" separadas por espacio; basta que una coincida.
// A diferencia de los otros webhooks, aquí NO hay modo dev sin secreto: este
// endpoint confirma pagos — sin secreto configurado se rechaza todo (fail closed).
export function verificarFirmaRecurrente(rawBody, { id, timestamp, signature }, secreto) {
  if (!secreto) {
    logger.error('RECURRENTE_WEBHOOK_SECRET no configurado: webhook de pago rechazado');
    return false;
  }

  if (!id || !timestamp || !signature) return false;

  // Ventana anti-replay de 5 minutos (PAGO_CONFIRMADO es idempotente; un replay
  // dentro de la ventana solo repetiría la notificación, no el cambio de estado).
  const desfase = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(desfase) || desfase > RECURRENTE_TOLERANCIA_SEGUNDOS) return false;

  const clave = Buffer.from(secreto.replace(/^whsec_/, ''), 'base64');
  const esperada = crypto.createHmac('sha256', clave).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  const bufEsperada = Buffer.from(esperada);

  return signature.split(' ').some((parte) => {
    const [version, firma] = parte.split(',');
    if (version !== 'v1' || !firma) return false;
    const bufFirma = Buffer.from(firma);
    return bufFirma.length === bufEsperada.length && crypto.timingSafeEqual(bufFirma, bufEsperada);
  });
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
