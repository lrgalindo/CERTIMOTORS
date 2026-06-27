import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcularCostoUSD,
  verificarPresupuesto,
  aplicarDegradacion,
  BUDGET_LIMIT_USD,
} from '../src/budget-tracker.js';

test('calcula costo en USD para Sonnet con tokens input/output', () => {
  const costo = calcularCostoUSD('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(costo, 3.0 + 15.0);
});

test('cache_read es ~10x mas barato que input normal', () => {
  const costoNormal = calcularCostoUSD('claude-opus-4-8', { input_tokens: 1_000_000 });
  const costoCacheado = calcularCostoUSD('claude-opus-4-8', { cache_read_input_tokens: 1_000_000 });
  assert.ok(costoCacheado < costoNormal / 5);
});

test('modelo sin precios definidos lanza error', () => {
  assert.throws(() => calcularCostoUSD('modelo-inexistente', {}));
});

test('verificarPresupuesto: normal por debajo del 80%', async () => {
  const dbFake = { obtenerGastoDesde: async () => [{ costo_estimado_usd: '10.00' }] };
  const resultado = await verificarPresupuesto(dbFake);
  assert.equal(resultado.nivel, 'normal');
  assert.equal(resultado.gastoMensual, 10);
  assert.equal(resultado.limite, BUDGET_LIMIT_USD);
});

test('verificarPresupuesto: degradado entre 80% y 100%', async () => {
  const gastoDegradado = BUDGET_LIMIT_USD * 0.85;
  const dbFake = { obtenerGastoDesde: async () => [{ costo_estimado_usd: String(gastoDegradado) }] };
  const resultado = await verificarPresupuesto(dbFake);
  assert.equal(resultado.nivel, 'degradado');
});

test('verificarPresupuesto: bloqueado al 100% o mas', async () => {
  const dbFake = { obtenerGastoDesde: async () => [{ costo_estimado_usd: String(BUDGET_LIMIT_USD) }] };
  const resultado = await verificarPresupuesto(dbFake);
  assert.equal(resultado.nivel, 'bloqueado');
});

test('aplicarDegradacion: nivel normal no cambia el modelo', () => {
  assert.equal(aplicarDegradacion('claude-opus-4-8', 'normal'), 'claude-opus-4-8');
});

test('aplicarDegradacion: nivel degradado baja Opus a Sonnet', () => {
  assert.equal(aplicarDegradacion('claude-opus-4-8', 'degradado'), 'claude-sonnet-4-6');
});

test('aplicarDegradacion: nivel bloqueado lanza error 402', () => {
  assert.throws(() => aplicarDegradacion('claude-opus-4-8', 'bloqueado'), (err) => err.statusCode === 402);
});
