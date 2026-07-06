import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularBackoffMs, calcularProximoIntento } from '../src/queue.js';

// worker.js importa db.js, que crea el cliente Supabase al cargar el módulo;
// se rellenan estas env vars antes del import dinámico para que no truene en CI.
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_KEY ||= 'test-key';
const { procesarJob, procesarLote, claveCliente } = await import('../src/worker.js');

const jobWhatsapp = (id, from, texto) => ({
  id,
  proveedor: 'whatsapp',
  payload: { entry: [{ changes: [{ value: { messages: [{ from, type: 'text', text: { body: texto } }] } }] }] },
  intentos: 0,
  max_intentos: 3,
});

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

test('claveCliente: extrae número de WhatsApp, id de Telegram, y fallback por job', () => {
  assert.equal(claveCliente(jobWhatsapp('j1', '50255551234', 'hola')), 'whatsapp:50255551234');
  assert.equal(
    claveCliente({ id: 'j2', proveedor: 'telegram_mecanico', payload: { message: { from: { id: 777 } } } }),
    'telegram_mecanico:777'
  );
  assert.equal(claveCliente({ id: 'j3', proveedor: 'whatsapp', payload: {} }), 'job:j3');
});

test('procesarLote: 3 jobs del mismo cliente se procesan en orden de llegada', async () => {
  const completados = [];
  const dbFake = {
    marcarJobCompletado: async () => {},
    marcarJobFallido: async () => {},
  };
  // Delays decrecientes: si corrieran en paralelo terminarían en orden inverso (3,2,1).
  const delays = { 'job-1': 30, 'job-2': 15, 'job-3': 0 };
  const procesadores = {
    whatsapp: async (payload) => {
      const texto = payload.entry[0].changes[0].value.messages[0].text.body;
      await new Promise((r) => setTimeout(r, delays[texto]));
      completados.push(texto);
    },
  };

  await procesarLote(
    { db: dbFake, procesadores },
    [jobWhatsapp('a', '50255551234', 'job-1'), jobWhatsapp('b', '50255551234', 'job-2'), jobWhatsapp('c', '50255551234', 'job-3')]
  );

  assert.deepEqual(completados, ['job-1', 'job-2', 'job-3']);
});

test('procesarLote: clientes distintos corren en paralelo', async () => {
  const completados = [];
  const dbFake = { marcarJobCompletado: async () => {}, marcarJobFallido: async () => {} };
  const delays = { lento: 30, rapido: 0 };
  const procesadores = {
    whatsapp: async (payload) => {
      const texto = payload.entry[0].changes[0].value.messages[0].text.body;
      await new Promise((r) => setTimeout(r, delays[texto]));
      completados.push(texto);
    },
  };

  // El cliente lento va primero en el lote; si fuera secuencial global, "rapido" saldría último.
  await procesarLote(
    { db: dbFake, procesadores },
    [jobWhatsapp('a', '50200000001', 'lento'), jobWhatsapp('b', '50200000002', 'rapido')]
  );

  assert.deepEqual(completados, ['rapido', 'lento']);
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
