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

// ─── Bloque 3d: fallback al cliente en job fallido permanente ─────────────────

import http from 'node:http';

function crearServidorFake(respondFn) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const resp = respondFn(parsed);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(resp));
      });
    });
    server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('procesarJob: job whatsapp fallido permanente envía WhatsApp de dificultades técnicas al cliente', async () => {
  const enviados = [];
  const { server, url } = await crearServidorFake((body) => {
    enviados.push(body);
    return { ok: true };
  });
  process.env.WHATSAPP_GRAPH_API_URL = url;
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_TOKEN = 'fake-token';

  const dbFake = {
    marcarJobCompletado: async () => {},
    marcarJobFallido: async () => {},
  };
  const procesadores = { whatsapp: async () => { throw new Error('fallo crítico'); } };

  const job = {
    id: 'job-perm',
    proveedor: 'whatsapp',
    payload: { entry: [{ changes: [{ value: { messages: [{ from: '50299999999', type: 'text', text: { body: 'hola' } }] } }] }] },
    intentos: 2, // intentos ya fue 2, ahora será 3 = max_intentos
    max_intentos: 3,
  };

  await procesarJob({ db: dbFake, procesadores }, job);

  const waMensaje = enviados.find((e) => e.messaging_product === 'whatsapp');
  assert.ok(waMensaje, 'debe haber enviado un mensaje WhatsApp');
  assert.equal(waMensaje.to, '50299999999');
  assert.ok(waMensaje.text.body.includes('dificultades técnicas'));

  server.close();
  delete process.env.WHATSAPP_GRAPH_API_URL;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_TOKEN;
});

// ─── Reaper de jobs huérfanos (incidente P0 jul 2026) ────────────────────────

const { recuperarJobsHuerfanos } = await import('../src/worker.js');

test('recuperarJobsHuerfanos: reencola huérfano con intentos disponibles', async () => {
  const llamadas = [];
  const dbFake = {
    obtenerJobsHuerfanos: async () => [
      { id: 'h1', proveedor: 'telegram_mecanico', payload: {}, intentos: 0, max_intentos: 3 },
    ],
    marcarJobFallido: async (id, info) => llamadas.push([id, info]),
  };

  const recuperados = await recuperarJobsHuerfanos({ db: dbFake });

  assert.equal(recuperados, 1);
  assert.equal(llamadas.length, 1);
  const [id, info] = llamadas[0];
  assert.equal(id, 'h1');
  assert.equal(info.intentos, 1);
  assert.equal(info.maxIntentos, 3);
  assert.match(info.error, /huérfano/);
});

test('recuperarJobsHuerfanos: huérfano sin intentos restantes queda permanente y avisa al cliente WhatsApp', async () => {
  const enviados = [];
  const { server, url } = await crearServidorFake((body) => {
    enviados.push(body);
    return { ok: true };
  });
  process.env.WHATSAPP_GRAPH_API_URL = url;
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_TOKEN = 'fake-token';

  const llamadas = [];
  const dbFake = {
    obtenerJobsHuerfanos: async () => [
      {
        id: 'h2',
        proveedor: 'whatsapp',
        payload: { entry: [{ changes: [{ value: { messages: [{ from: '50288888888' }] } }] }] },
        intentos: 2,
        max_intentos: 3,
      },
    ],
    marcarJobFallido: async (id, info) => llamadas.push([id, info]),
  };

  await recuperarJobsHuerfanos({ db: dbFake });

  // intentos llega a max => marcarJobFallido lo dejará fallido_permanente
  assert.equal(llamadas[0][1].intentos, 3);
  const waMensaje = enviados.find((e) => e.messaging_product === 'whatsapp');
  assert.ok(waMensaje, 'debe avisar al cliente por WhatsApp');
  assert.equal(waMensaje.to, '50288888888');

  server.close();
  delete process.env.WHATSAPP_GRAPH_API_URL;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_TOKEN;
});

test('recuperarJobsHuerfanos: sin huérfanos no toca nada', async () => {
  const dbFake = {
    obtenerJobsHuerfanos: async () => [],
    marcarJobFallido: async () => {
      throw new Error('no debería llamarse');
    },
  };
  assert.equal(await recuperarJobsHuerfanos({ db: dbFake }), 0);
});

// ─── Transición de status del reaper, de punta a punta ────────────────────────
// Regresión pedida tras el incidente: verificar explícitamente que el job
// rescatado CAMBIA de status ('pendiente' o 'fallido_permanente'), no solo que
// se le escribe el texto de error. El fake usa statusTrasFallo, la misma
// función con la que db.marcarJobFallido decide el status en producción.

import { statusTrasFallo } from '../src/queue.js';

test('statusTrasFallo: pendiente con intentos disponibles, permanente al agotarlos', () => {
  assert.equal(statusTrasFallo(1, 3), 'pendiente');
  assert.equal(statusTrasFallo(2, 3), 'pendiente');
  assert.equal(statusTrasFallo(3, 3), 'fallido_permanente');
  assert.equal(statusTrasFallo(4, 3), 'fallido_permanente');
});

test('recuperarJobsHuerfanos: el status del job transiciona, no queda en procesando', async () => {
  const filas = {
    h1: { id: 'h1', proveedor: 'telegram_mecanico', payload: {}, intentos: 0, max_intentos: 3, status: 'procesando' },
    h2: { id: 'h2', proveedor: 'telegram_mecanico', payload: {}, intentos: 2, max_intentos: 3, status: 'procesando' },
  };
  const dbFake = {
    obtenerJobsHuerfanos: async () => Object.values(filas),
    // Mismo contrato que db.marcarJobFallido: el status sale de statusTrasFallo.
    marcarJobFallido: async (id, { intentos, maxIntentos, error }) => {
      filas[id] = { ...filas[id], status: statusTrasFallo(intentos, maxIntentos), intentos, error };
    },
  };

  await recuperarJobsHuerfanos({ db: dbFake });

  assert.equal(filas.h1.status, 'pendiente');
  assert.equal(filas.h1.intentos, 1);
  assert.equal(filas.h2.status, 'fallido_permanente');
  assert.equal(filas.h2.intentos, 3);
  assert.match(filas.h1.error, /huérfano/);
});
