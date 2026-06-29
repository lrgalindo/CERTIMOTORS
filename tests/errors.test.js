import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, ClaudeAPIError, handleError } from '../src/errors.js';

function crearResFake() {
  const llamadas = {};
  const res = {
    status(code) {
      llamadas.statusCode = code;
      return res;
    },
    json(body) {
      llamadas.body = body;
      return res;
    },
  };
  return { res, llamadas };
}

test('AppError: usa 500 por default y el mensaje dado', () => {
  const err = new AppError('algo falló');
  assert.equal(err.statusCode, 500);
  assert.equal(err.message, 'algo falló');
});

test('AppError: respeta el statusCode dado', () => {
  const err = new AppError('no encontrado', 404);
  assert.equal(err.statusCode, 404);
});

test('ClaudeAPIError: siempre es 502 y conserva la causa', () => {
  const causa = new Error('timeout');
  const err = new ClaudeAPIError('Claude API: timeout', causa);
  assert.equal(err.statusCode, 502);
  assert.equal(err.cause, causa);
  assert.ok(err instanceof AppError);
});

test('handleError: usa el statusCode del error y formatea el body', () => {
  const { res, llamadas } = crearResFake();
  handleError(new AppError('orden no encontrada', 404), res);
  assert.equal(llamadas.statusCode, 404);
  assert.deepEqual(llamadas.body, { error: 'orden no encontrada', status: 'error' });
});

test('handleError: cae a 500 si el error no tiene statusCode', () => {
  const { res, llamadas } = crearResFake();
  handleError(new Error('boom'), res);
  assert.equal(llamadas.statusCode, 500);
  assert.deepEqual(llamadas.body, { error: 'boom', status: 'error' });
});
