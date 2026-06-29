import test from 'node:test';
import assert from 'node:assert/strict';
import { generarCertificadoPDF } from '../src/pdf-generator.js';

const hallazgosMock = [
  { punto: 1, nombre_punto: 'Motor', estado: 'BIEN' },
  { punto: 2, nombre_punto: 'Frenos', estado: 'MAL', observacion: 'Pastillas gastadas' },
  { punto: 3, nombre_punto: 'Suspensión', estado: 'REGULAR' },
];

test('generarCertificadoPDF: retorna un Buffer no vacío', () => {
  const result = generarCertificadoPDF('P926FTB', hallazgosMock);
  assert.ok(result instanceof Buffer, 'debe retornar un Buffer');
  assert.ok(result.length > 0, 'el Buffer no debe estar vacío');
});

test('generarCertificadoPDF: el Buffer contiene la placa y los hallazgos', () => {
  const result = generarCertificadoPDF('P926FTB', hallazgosMock);
  const contenido = result.toString('utf8');
  assert.ok(contenido.includes('P926FTB'), 'debe incluir la placa');
  assert.ok(contenido.includes('Motor'), 'debe incluir nombre del punto 1');
  assert.ok(contenido.includes('Pastillas gastadas'), 'debe incluir observación del punto 2');
  assert.ok(contenido.includes('MAL'), 'debe incluir el estado MAL');
});

test('generarCertificadoPDF: lanza AppError 422 cuando hallazgos está vacío', () => {
  assert.throws(() => generarCertificadoPDF('P926FTB', []), (err) => {
    assert.equal(err.statusCode, 422);
    assert.ok(err.message.includes('P926FTB'));
    return true;
  });
});

test('generarCertificadoPDF: lanza AppError 422 cuando hallazgos es null', () => {
  assert.throws(() => generarCertificadoPDF('P926FTB', null), (err) => {
    assert.equal(err.statusCode, 422);
    return true;
  });
});

test('generarCertificadoPDF: incluye todos los hallazgos en el Buffer', () => {
  const result = generarCertificadoPDF('P926FTB', hallazgosMock);
  const contenido = result.toString('utf8');
  assert.ok(contenido.includes('Total puntos inspeccionados: 3'));
});
