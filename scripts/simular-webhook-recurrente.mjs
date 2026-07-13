// Simula el webhook de pago de Recurrente con firma Svix REAL contra el
// endpoint de producción. Uso legítimo: validar nuestra verificación de firma
// y la transición de estado cuando el sandbox de Recurrente no envía webhooks
// (su doc: "Los webhooks no se envían para checkouts creados con llaves de test").
//
// Uso (el secreto nunca sale de tu terminal):
//   RECURRENTE_WEBHOOK_SECRET=whsec_... node scripts/simular-webhook-recurrente.mjs T111TST
//
import crypto from 'node:crypto';

const placa = process.argv[2];
const secreto = process.env.RECURRENTE_WEBHOOK_SECRET;
const url = process.env.WEBHOOK_URL || 'https://certimotors.onrender.com/webhook/recurrente';

if (!placa || !secreto) {
  console.error('Uso: RECURRENTE_WEBHOOK_SECRET=whsec_... node scripts/simular-webhook-recurrente.mjs <PLACA>');
  process.exit(1);
}

const body = JSON.stringify({
  event_type: 'payment_intent.succeeded',
  checkout: { metadata: { placa, servicio: 'BASICO' } },
  simulacion: 'prueba E2E firmada — no es un webhook real de Recurrente',
});

// Mismo esquema que verifica src/webhook-security.js: HMAC-SHA256 base64 de
// "{id}.{timestamp}.{body}" con clave = base64(secreto sin prefijo whsec_).
const id = `msg_sim_${Date.now()}`;
const timestamp = String(Math.floor(Date.now() / 1000));
const clave = Buffer.from(secreto.replace(/^whsec_/, ''), 'base64');
const firma = crypto.createHmac('sha256', clave).update(`${id}.${timestamp}.${body}`).digest('base64');

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${firma}`,
  },
  body,
});
console.log(`HTTP ${res.status}: ${await res.text()}`);
