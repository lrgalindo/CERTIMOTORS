import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guardia de naming: desde julio 2026 los servicios son BASICO (Q550) y FULL (Q1,200).
// Este test falla si el naming o los precios viejos vuelven a aparecer en src/ o migrations/.
//
// Diseño de los patrones (deliberadamente case-sensitive y con tilde explícita):
// - NO se busca "standard" ni variantes en inglés: `standardHeaders` en src/ratelimit.js
//   es una opción de configuración de express-rate-limit y es legítima.
// - NO se busca `ESTANDAR` (mayúsculas sin tilde): migrations/005_servicio_basico.sql
//   necesita referenciarlo en su UPDATE de renombrado — es el valor viejo que migra.
// - migrations/004_certificado_pdf.sql se excluye por completo: es registro histórico
//   inmutable con el viejo DEFAULT 'ESTANDAR'.
// - La frase "estándar Svix" (comentario en src/webhook-security.js) se descuenta antes
//   de escanear: ahí "estándar" es la palabra genérica en español para el esquema de
//   firma Svix, no el nombre del servicio.

const RAIZ = new URL('..', import.meta.url).pathname;
const DIRECTORIOS = ['src', 'migrations'];
const ARCHIVOS_EXCLUIDOS = new Set(['migrations/004_certificado_pdf.sql']);
const FRASES_BENIGNAS = [/est[aá]ndar\s+Svix/gi];

const PATRONES_PROHIBIDOS = [
  { patron: /ESTÁNDAR/g, motivo: 'nombre viejo del servicio (renombrado a BASICO)' },
  { patron: /estandar/g, motivo: 'nombre viejo del servicio (renombrado a BASICO)' },
  { patron: /estándar/g, motivo: 'nombre viejo del servicio (renombrado a BASICO)' },
  { patron: /Q650/g, motivo: 'precio viejo (BÁSICO ahora es Q550)' },
  { patron: /Q800/g, motivo: 'precio viejo (no existe en la tabla actual)' },
  { patron: /Q1,400/g, motivo: 'precio viejo (FULL ahora es Q1,200)' },
];

function archivosAEscanear() {
  const archivos = [];
  for (const dir of DIRECTORIOS) {
    for (const nombre of readdirSync(join(RAIZ, dir))) {
      const relativo = `${dir}/${nombre}`;
      if (ARCHIVOS_EXCLUIDOS.has(relativo)) continue;
      if (!/\.(js|sql)$/.test(nombre)) continue;
      archivos.push(relativo);
    }
  }
  return archivos;
}

test('naming: src/ y migrations/ no contienen el servicio ni los precios viejos', () => {
  const archivos = archivosAEscanear();
  assert.ok(archivos.length > 0, 'debe haber archivos que escanear');

  const violaciones = [];
  for (const relativo of archivos) {
    let contenido = readFileSync(join(RAIZ, relativo), 'utf8');
    for (const frase of FRASES_BENIGNAS) contenido = contenido.replace(frase, '');

    const lineas = contenido.split('\n');
    for (const { patron, motivo } of PATRONES_PROHIBIDOS) {
      lineas.forEach((linea, i) => {
        if (patron.test(linea)) {
          violaciones.push(`${relativo}:${i + 1} contiene ${patron.source} — ${motivo}`);
        }
        patron.lastIndex = 0;
      });
    }
  }

  assert.deepEqual(violaciones, [], `Naming legado encontrado:\n${violaciones.join('\n')}`);
});
