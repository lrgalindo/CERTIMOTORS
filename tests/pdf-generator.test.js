import test from 'node:test';
import assert from 'node:assert/strict';
import { generarCertificado } from '../src/pdf-generator.js';

// generarCertificado(placa, db) is async, calls Claude + PDFKit + Supabase Storage.
// We test the contract boundaries (export shape, early error paths) without
// a real DB or network — full PDF generation is covered by manual / e2e tests.

test('generarCertificado: la función está exportada y es asíncrona', () => {
  assert.equal(typeof generarCertificado, 'function');
  // AsyncFunction has a constructor name of 'AsyncFunction'
  assert.equal(generarCertificado.constructor.name, 'AsyncFunction');
});

test('generarCertificado: lanza AppError 404 si la orden no existe', async () => {
  const db = {
    obtenerOrdenPorPlaca: async () => null,
    obtenerRevisionesPorPlaca: async () => [],
    obtenerNotificacionesPorPlacaYTipos: async () => [],
    obtenerGastoDesde: async () => [],
    registrarCostoAPI: async () => {},
    asegurarBucketCertificados: async () => {},
    subirCertificado: async () => 'http://fake.url/cert.pdf',
    guardarCertificado: async () => {},
  };

  await assert.rejects(
    () => generarCertificado('P926FTB', db),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.ok(err.message.toLowerCase().includes('orden'));
      return true;
    }
  );
});
