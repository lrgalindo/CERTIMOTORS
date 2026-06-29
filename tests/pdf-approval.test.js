import test from 'node:test';
import assert from 'node:assert/strict';
import { notificarAdminParaAprobacion, procesarCallbackAprobacion, procesarCallbackCorreccion } from '../src/pdf-approval.js';

function crearDbFake(overrides = {}) {
  const tokens = new Map(); // token → { placa, usado }
  const notificaciones = [];
  const ordenes = {
    P926FTB: { id: 'orden-1', placa: 'P926FTB', cliente_id: 'cliente-1', status: 'TRAMITE_COMPLETO' },
  };

  return {
    guardarTokenAprobacion: async (placa, token) => {
      tokens.set(token, { placa, usado: false });
    },
    obtenerPlacaPorToken: async (token) => {
      const entry = tokens.get(token);
      if (!entry || entry.usado) return null;
      return entry.placa;
    },
    marcarTokenUsado: async (token) => {
      const entry = tokens.get(token);
      if (entry) entry.usado = true;
    },
    actualizarStatusOrden: async (placa, status) => {
      ordenes[placa] = { ...ordenes[placa], status };
    },
    crearNotificacion: async (placa, tipo, mensaje) => {
      const fila = { placa, tipo, mensaje };
      notificaciones.push(fila);
      return fila;
    },
    _tokens: tokens,
    _notificaciones: notificaciones,
    _ordenes: ordenes,
    ...overrides,
  };
}

const PDF_FAKE = Buffer.from('PDF content', 'utf8');

test('notificarAdminParaAprobacion: genera token y crea notificación APROBACION_PENDIENTE', async () => {
  const db = crearDbFake();
  const { token, placa } = await notificarAdminParaAprobacion(db, 'P926FTB', PDF_FAKE);

  assert.ok(token, 'debe devolver un token');
  assert.equal(placa, 'P926FTB');
  assert.ok(db._tokens.has(token), 'el token debe estar guardado en db');
  assert.equal(db._tokens.get(token).placa, 'P926FTB');
  assert.equal(db._notificaciones.length, 1);
  assert.equal(db._notificaciones[0].tipo, 'APROBACION_PENDIENTE');
});

test('notificarAdminParaAprobacion: lanza AppError 422 si el PDF está vacío', async () => {
  const db = crearDbFake();
  await assert.rejects(
    () => notificarAdminParaAprobacion(db, 'P926FTB', Buffer.alloc(0)),
    (err) => {
      assert.equal(err.statusCode, 422);
      return true;
    }
  );
});

test('procesarCallbackAprobacion: aprueba la orden y marca el token como usado', async () => {
  const db = crearDbFake();
  const { token } = await notificarAdminParaAprobacion(db, 'P926FTB', PDF_FAKE);

  const resultado = await procesarCallbackAprobacion(db, token);

  assert.equal(resultado.status, 'APROBADO');
  assert.equal(resultado.placa, 'P926FTB');
  assert.equal(db._ordenes.P926FTB.status, 'CERTIFICADO_APROBADO');
  assert.ok(db._tokens.get(token).usado, 'el token debe quedar marcado como usado');
  const tiposNotif = db._notificaciones.map((n) => n.tipo);
  assert.ok(tiposNotif.includes('CERTIFICADO_APROBADO'));
});

test('procesarCallbackAprobacion: rechaza token inválido con AppError 401', async () => {
  const db = crearDbFake();
  await assert.rejects(
    () => procesarCallbackAprobacion(db, 'token-falso-xxx'),
    (err) => {
      assert.equal(err.statusCode, 401);
      return true;
    }
  );
});

test('procesarCallbackAprobacion: rechaza token ya usado con AppError 401', async () => {
  const db = crearDbFake();
  const { token } = await notificarAdminParaAprobacion(db, 'P926FTB', PDF_FAKE);
  await procesarCallbackAprobacion(db, token);

  await assert.rejects(
    () => procesarCallbackAprobacion(db, token),
    (err) => {
      assert.equal(err.statusCode, 401);
      return true;
    }
  );
});

test('procesarCallbackCorreccion: marca la orden como NECESITA_CORRECCION con notas', async () => {
  const db = crearDbFake();
  const { token } = await notificarAdminParaAprobacion(db, 'P926FTB', PDF_FAKE);

  const resultado = await procesarCallbackCorreccion(db, token, 'Falta el sello de SAT');

  assert.equal(resultado.status, 'NECESITA_CORRECCION');
  assert.equal(resultado.placa, 'P926FTB');
  assert.equal(db._ordenes.P926FTB.status, 'NECESITA_CORRECCION');
  const correccion = db._notificaciones.find((n) => n.tipo === 'NECESITA_CORRECCION');
  assert.ok(correccion.mensaje.includes('Falta el sello de SAT'));
});

test('procesarCallbackCorreccion: rechaza token inválido con AppError 401', async () => {
  const db = crearDbFake();
  await assert.rejects(
    () => procesarCallbackCorreccion(db, 'token-inventado', 'notas'),
    (err) => {
      assert.equal(err.statusCode, 401);
      return true;
    }
  );
});
