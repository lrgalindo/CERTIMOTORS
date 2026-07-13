import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlaca, validatePhoneNumber, validateMessage } from '../src/validators.js';

test('validatePlaca: acepta el formato P926FTB', () => {
  assert.doesNotThrow(() => validatePlaca('P926FTB'));
});

test('validatePlaca: rechaza minúsculas, formato incorrecto, vacío o no-string', () => {
  assert.throws(() => validatePlaca('p926ftb'), (err) => err.statusCode === 400);
  assert.throws(() => validatePlaca('P926FT'), (err) => err.statusCode === 400);
  assert.throws(() => validatePlaca(''), (err) => err.statusCode === 400);
  assert.throws(() => validatePlaca(null), (err) => err.statusCode === 400);
  assert.throws(() => validatePlaca(926), (err) => err.statusCode === 400);
});

test('validatePhoneNumber: acepta 8 a 15 dígitos', () => {
  assert.doesNotThrow(() => validatePhoneNumber('50212345678'));
  assert.doesNotThrow(() => validatePhoneNumber('12345678'));
  assert.doesNotThrow(() => validatePhoneNumber('123456789012345'));
});

test('validatePhoneNumber: rechaza letras, longitud fuera de rango o vacío', () => {
  assert.throws(() => validatePhoneNumber('502abc45678'), (err) => err.statusCode === 400);
  assert.throws(() => validatePhoneNumber('1234567'), (err) => err.statusCode === 400);
  assert.throws(() => validatePhoneNumber('1234567890123456'), (err) => err.statusCode === 400);
  assert.throws(() => validatePhoneNumber(''), (err) => err.statusCode === 400);
});

test('validateMessage: acepta texto no vacío', () => {
  assert.doesNotThrow(() => validateMessage('Hola, quiero certificar mi auto'));
});

test('validateMessage: rechaza vacío, solo espacios o no-string', () => {
  assert.throws(() => validateMessage(''), (err) => err.statusCode === 400);
  assert.throws(() => validateMessage('   '), (err) => err.statusCode === 400);
  assert.throws(() => validateMessage(null), (err) => err.statusCode === 400);
});
