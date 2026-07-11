import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estadoInicial,
  actualizarEstado,
  extraerDatos,
  camposFaltantes,
  contextoParaPrompt,
} from '../src/estado-conversacion.js';

test('estadoInicial arranca en 0_bienvenida como sales, sin pre-marcar nada', () => {
  const e = estadoInicial();
  assert.equal(e.etapa, '0_bienvenida');
  assert.equal(e.persona_activa, 'sales');
  assert.equal(e.campos.upsell_segunda_inspeccion, false);
  assert.equal(e.campos.monto_confirmado, false);
});

test('actualizarEstado avanza etapa por etapa según campos completos', () => {
  let e = actualizarEstado(estadoInicial(), {});
  assert.equal(e.etapa, '1_plan');

  e = actualizarEstado(e, { plan_elegido: 'FULL' });
  assert.equal(e.etapa, '2_contacto');

  e = actualizarEstado(e, { nombre: 'Juan Pérez', telefono_confirmado: '50212345678' });
  assert.equal(e.etapa, '3_vehiculo_zona');

  e = actualizarEstado(e, { placa: 'P926FTB', marca: 'Toyota', modelo: 'Corolla', anio: 2019, zona: 'MIXCO', es_dueno: true });
  assert.equal(e.etapa, '4_agendamiento');

  e = actualizarEstado(e, { fecha_tentativa: '2026-07-15', hora_tentativa: 'por la mañana' });
  assert.equal(e.etapa, '5_pago');
  assert.equal(e.persona_activa, 'sales');

  e = actualizarEstado(e, { monto_confirmado: true });
  assert.equal(e.etapa, '6_seguimiento');
  assert.equal(e.persona_activa, 'sac');
});

test('extraerDatos: valida y normaliza; descarta campos desconocidos o inválidos', () => {
  const { texto, datos } = extraerDatos(
    'Anotado. [DATO:anio=2019] [DATO:zona=mixco] [DATO:placa=p 926 ftb] [DATO:anio_falso=99] [DATO:anio=no sé]'
  );
  assert.equal(texto, 'Anotado.');
  assert.deepEqual(datos, { anio: 2019, zona: 'MIXCO', placa: 'P926FTB' });
});

test('extraerDatos: "zona 10" normaliza a CAPITAL; año fuera de rango se descarta', () => {
  const { datos } = extraerDatos('[DATO:zona=zona 10] [DATO:anio=1890]');
  assert.deepEqual(datos, { zona: 'CAPITAL' });
});

test('camposFaltantes y contextoParaPrompt reflejan solo lo que falta de la etapa actual', () => {
  const e = actualizarEstado(estadoInicial(), {
    plan_elegido: 'BASICO',
    nombre: 'Ana',
    telefono_confirmado: '50211112222',
    placa: 'P111AAA',
    marca: 'Honda',
  });
  assert.equal(e.etapa, '3_vehiculo_zona');
  assert.deepEqual(camposFaltantes(e), ['modelo', 'anio', 'zona', 'es_dueno']);
  const ctx = contextoParaPrompt(e);
  assert.ok(ctx.includes('modelo, anio, zona, es_dueno'));
  assert.ok(!ctx.includes('placa,'), 'no debe pedir datos ya confirmados');
});

test('un dato ya confirmado no se borra con una actualización vacía', () => {
  const e1 = actualizarEstado(estadoInicial(), { anio: 2019 });
  const e2 = actualizarEstado(e1, {});
  assert.equal(e2.campos.anio, 2019);
});
