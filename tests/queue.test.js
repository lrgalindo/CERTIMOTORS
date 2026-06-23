import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularBackoffMs, calcularProximoIntento } from '../src/queue.js';

// worker.js importa db.js, que crea el cliente Supabase al cargar el módulo;
// se rellenan estas env vars antes del import dinámico para que no truene en CI.
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_KEY ||= 'test-key';
const { procesarJob } = await import('../src/worker.js');

test('calcularBackoffMs: backoff exponencial empezando en 1s', () => {
  assert.equal(calcularBackoffMs(1), 1000);
  assert.equal(calcularBackoffMs(2), 2000);
  assert.equal(calcularBackoffMs(3), 4000);
});

test('calcularProximoIntento: fecha futura acorde al backoff', () => {
  const antes = Date.now();
  const proximo = new Date(calcularProximoIntento(1)).getTime();
  assert.ok(proximo >= antes + 1000);
});

test('procesarJob: marca completado cuando el procesador no lanza error', async () => {
  const llamadas = [];
  const dbFake = {
    marcarJobCompletado: async (id) => llamadas.push(['completado', id]),
    marcarJobFallido: async (id) => llamadas.push(['fallido', id]),
  };
  const procesadores = { whatsapp: async () => {} };

  await procesarJob({ db: dbFake, procesadores }, { id: 'job-1', proveedor: 'whatsapp', payload: {}, intentos: 0, max_intentos: 3 });

  assert.deepEqual(llamadas, [['completado', 'job-1']]);
});

test('procesarJob: reintenta con backoff cuando el procesador falla', async () => {
  const llamadas = [];
  const dbFake = {
    marcarJobCompletado: async (id) => llamadas.push(['completado', id]),
    marcarJobFallido: async (id, info) => llamadas.push(['fallido', id, info]),
  };
  const procesadores = {
    whatsapp: async () => {
      throw new Error('Claude API caída');
    },
  };

  await procesarJob({ db: dbFake, procesadores }, { id: 'job-2', proveedor: 'whatsapp', payload: {}, intentos: 0, max_intentos: 3 });

  assert.equal(llamadas.length, 1);
  const [tipo, id, info] = llamadas[0];
  assert.equal(tipo, 'fallido');
  assert.equal(id, 'job-2');
  assert.equal(info.intentos, 1);
  assert.equal(info.maxIntentos, 3);
  assert.equal(info.error, 'Claude API caída');
});

test('procesarJob: proveedor desconocido marca fallido con max_intentos directamente', async () => {
  const llamadas = [];
  const dbFake = {
    marcarJobCompletado: async (id) => llamadas.push(['completado', id]),
    marcarJobFallido: async (id, info) => llamadas.push(['fallido', id, info]),
  };

  await procesarJob({ db: dbFake, procesadores: {} }, { id: 'job-3', proveedor: 'desconocido', payload: {}, intentos: 0, max_intentos: 3 });

  assert.equal(llamadas.length, 1);
  const [tipo, , info] = llamadas[0];
  assert.equal(tipo, 'fallido');
  assert.equal(info.intentos, 3);
  assert.equal(info.maxIntentos, 3);
});
