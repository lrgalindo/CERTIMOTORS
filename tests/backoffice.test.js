import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { crearBackofficeRouter } from '../src/backoffice.js';

const dbFake = {
  listarOrdenes: async () => [
    { placa: 'P926FTB', status: 'ESPERANDO_PAGO', servicio: 'FULL', cliente_id: 'c1', created_at: '2026-07-08', updated_at: '2026-07-08' },
  ],
  listarJobs: async () => [],
  listarClientes: async () => [{ numero_telefono: '50212345678', nombre: '<script>x</script>', created_at: '2026-07-08' }],
  obtenerStatsReporte: async () => ({ gasto_dia_usd: 0.12 }),
  obtenerGastoDesde: async () => [{ costo_estimado_usd: 3.5 }],
};

async function conServidor(fn) {
  const app = express();
  app.use('/backoffice', crearBackofficeRouter(dbFake));
  const server = app.listen(0);
  try {
    await fn(`http://localhost:${server.address().port}/backoffice/`);
  } finally {
    server.close();
  }
}

test('backoffice: sin credenciales configuradas responde 503 (fail closed)', async () => {
  delete process.env.BACKOFFICE_USER;
  delete process.env.BACKOFFICE_PASS;
  await conServidor(async (url) => {
    const res = await fetch(url);
    assert.equal(res.status, 503);
  });
});

test('backoffice: sin auth responde 401, con credenciales correctas 200 y escapa HTML', async () => {
  process.env.BACKOFFICE_USER = 'rodrigo';
  process.env.BACKOFFICE_PASS = 'secreto123';
  await conServidor(async (url) => {
    const sinAuth = await fetch(url);
    assert.equal(sinAuth.status, 401);
    assert.match(sinAuth.headers.get('www-authenticate') || '', /Basic/);

    const malaPass = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from('rodrigo:otra').toString('base64')}` },
    });
    assert.equal(malaPass.status, 401);

    const ok = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from('rodrigo:secreto123').toString('base64')}` },
    });
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.ok(html.includes('P926FTB'));
    assert.ok(html.includes('&lt;script&gt;'), 'el nombre del cliente debe salir escapado');
    assert.ok(!html.includes('<script>x</script>'));
  });
  delete process.env.BACKOFFICE_USER;
  delete process.env.BACKOFFICE_PASS;
});
