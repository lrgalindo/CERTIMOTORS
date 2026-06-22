import test from 'node:test';
import assert from 'node:assert/strict';
import {
  seleccionarModelo,
  seleccionarMaxTokens,
  seleccionarModeloPorRol,
  TASK_TYPES,
} from '../src/model-router.js';

test('clasificación usa el modelo más económico (Haiku)', () => {
  assert.equal(seleccionarModelo(TASK_TYPES.CLASIFICACION), 'claude-haiku-4-5');
});

test('conversación y extracción usan Sonnet por default', () => {
  assert.equal(seleccionarModelo(TASK_TYPES.CONVERSACION), 'claude-sonnet-4-6');
  assert.equal(seleccionarModelo(TASK_TYPES.EXTRACCION), 'claude-sonnet-4-6');
});

test('razonamiento profundo usa el modelo superior (Opus)', () => {
  assert.equal(seleccionarModelo(TASK_TYPES.RAZONAMIENTO_PROFUNDO), 'claude-opus-4-8');
});

test('tipo de tarea desconocido lanza error en vez de degradar silenciosamente', () => {
  assert.throws(() => seleccionarModelo('inexistente'));
  assert.throws(() => seleccionarMaxTokens('inexistente'));
});

test('max_tokens varía por tipo de tarea, no es un techo fijo', () => {
  const clasificacion = seleccionarMaxTokens(TASK_TYPES.CLASIFICACION);
  const razonamiento = seleccionarMaxTokens(TASK_TYPES.RAZONAMIENTO_PROFUNDO);
  assert.ok(clasificacion < razonamiento);
});

test('cada uno de los 5 roles de negocio resuelve a un modelo válido', () => {
  for (const rol of ['cliente', 'mecanico', 'tramitador', 'validator', 'reporter']) {
    const { modelo, maxTokens } = seleccionarModeloPorRol(rol);
    assert.ok(modelo);
    assert.ok(maxTokens > 0);
  }
});

test('validator y reporter usan el modelo superior (razonamiento profundo)', () => {
  assert.equal(seleccionarModeloPorRol('validator').modelo, 'claude-opus-4-8');
  assert.equal(seleccionarModeloPorRol('reporter').modelo, 'claude-opus-4-8');
});

test('rol desconocido lanza error', () => {
  assert.throws(() => seleccionarModeloPorRol('rol-inexistente'));
});
