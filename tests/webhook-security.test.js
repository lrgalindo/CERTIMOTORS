import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verificarFirmaWhatsapp, verificarSecretoTelegram, verificarFirmaRecurrente } from '../src/webhook-security.js';

function firmarSvix(rawBody, id, timestamp, secreto) {
  const clave = Buffer.from(secreto.replace(/^whsec_/, ''), 'base64');
  return 'v1,' + crypto.createHmac('sha256', clave).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
}

test('verificarFirmaRecurrente: acepta firma svix v1 correcta con timestamp fresco', () => {
  const secreto = 'whsec_' + Buffer.from('clave-de-prueba').toString('base64');
  const rawBody = Buffer.from(JSON.stringify({ event_type: 'payment_intent.succeeded' }));
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { id: 'msg_1', timestamp: ts, signature: firmarSvix(rawBody, 'msg_1', ts, secreto) };

  assert.equal(verificarFirmaRecurrente(rawBody, headers, secreto), true);
});

test('verificarFirmaRecurrente: acepta si alguna de varias firmas coincide', () => {
  const secreto = 'whsec_' + Buffer.from('clave-de-prueba').toString('base64');
  const rawBody = Buffer.from('{}');
  const ts = String(Math.floor(Date.now() / 1000));
  const buena = firmarSvix(rawBody, 'msg_2', ts, secreto);
  const headers = { id: 'msg_2', timestamp: ts, signature: `v1,ZmFsc2E= ${buena}` };

  assert.equal(verificarFirmaRecurrente(rawBody, headers, secreto), true);
});

test('verificarFirmaRecurrente: rechaza firma incorrecta o headers faltantes', () => {
  const secreto = 'whsec_' + Buffer.from('clave-de-prueba').toString('base64');
  const rawBody = Buffer.from('{}');
  const ts = String(Math.floor(Date.now() / 1000));

  assert.equal(verificarFirmaRecurrente(rawBody, { id: 'msg_3', timestamp: ts, signature: 'v1,bm9wZQ==' }, secreto), false);
  assert.equal(verificarFirmaRecurrente(rawBody, { id: 'msg_3', timestamp: ts }, secreto), false);
});

test('verificarFirmaRecurrente: rechaza timestamp fuera de la ventana anti-replay', () => {
  const secreto = 'whsec_' + Buffer.from('clave-de-prueba').toString('base64');
  const rawBody = Buffer.from('{}');
  const tsViejo = String(Math.floor(Date.now() / 1000) - 600); // 10 min atrás
  const headers = { id: 'msg_4', timestamp: tsViejo, signature: firmarSvix(rawBody, 'msg_4', tsViejo, secreto) };

  assert.equal(verificarFirmaRecurrente(rawBody, headers, secreto), false);
});

test('verificarFirmaRecurrente: sin secreto configurado rechaza (fail closed — endpoint de pago)', () => {
  assert.equal(verificarFirmaRecurrente(Buffer.from('{}'), {}, undefined), false);
});

test('verificarFirmaWhatsapp: acepta firma HMAC SHA-256 correcta', () => {
  const secret = 'app-secret';
  const rawBody = Buffer.from(JSON.stringify({ hola: 'mundo' }));
  const firma = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  assert.equal(verificarFirmaWhatsapp(rawBody, firma, secret), true);
});

test('verificarFirmaWhatsapp: rechaza firma incorrecta', () => {
  const rawBody = Buffer.from(JSON.stringify({ hola: 'mundo' }));
  assert.equal(verificarFirmaWhatsapp(rawBody, 'sha256=deadbeef', 'app-secret'), false);
});

test('verificarFirmaWhatsapp: rechaza header sin prefijo sha256=', () => {
  const rawBody = Buffer.from('{}');
  assert.equal(verificarFirmaWhatsapp(rawBody, 'deadbeef', 'app-secret'), false);
});

test('verificarFirmaWhatsapp: rechaza cuando falta el header', () => {
  const rawBody = Buffer.from('{}');
  assert.equal(verificarFirmaWhatsapp(rawBody, undefined, 'app-secret'), false);
});

test('verificarFirmaWhatsapp: sin APP_SECRET configurado, deja pasar (modo dev)', () => {
  const rawBody = Buffer.from('{}');
  assert.equal(verificarFirmaWhatsapp(rawBody, undefined, undefined), true);
});

test('verificarSecretoTelegram: acepta cuando el header coincide', () => {
  assert.equal(verificarSecretoTelegram('mi-secreto', 'mi-secreto'), true);
});

test('verificarSecretoTelegram: rechaza cuando no coincide', () => {
  assert.equal(verificarSecretoTelegram('otro-secreto', 'mi-secreto'), false);
});

test('verificarSecretoTelegram: rechaza cuando falta el header y hay secreto esperado', () => {
  assert.equal(verificarSecretoTelegram(undefined, 'mi-secreto'), false);
});

test('verificarSecretoTelegram: sin secreto esperado configurado, deja pasar (modo dev)', () => {
  assert.equal(verificarSecretoTelegram(undefined, undefined), true);
});
