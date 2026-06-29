import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verificarFirmaWhatsapp, verificarSecretoTelegram } from '../src/webhook-security.js';

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
