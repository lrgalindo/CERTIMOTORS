import { AppError } from './errors.js';
import { logger } from './logger.js';

export function generarCertificadoPDF(placa, hallazgos) {
  if (!hallazgos || hallazgos.length === 0) {
    throw new AppError(`No hay hallazgos para generar el certificado de ${placa}`, 422);
  }

  const fecha = new Date().toISOString().split('T')[0];
  const lineas = [
    'CERTIMOTORS - CERTIFICADO DE INSPECCIÓN VEHICULAR',
    `Placa: ${placa}`,
    `Fecha: ${fecha}`,
    '',
    'HALLAZGOS DE INSPECCIÓN:',
    ...hallazgos.map(
      (h) =>
        `  [${h.estado}] Punto ${h.punto} - ${h.nombre_punto || 'Sin nombre'}${h.observacion ? `: ${h.observacion}` : ''}`
    ),
    '',
    `Total puntos inspeccionados: ${hallazgos.length}`,
  ];

  const contenido = lineas.join('\n');
  logger.info('Certificado PDF generado', { placa, puntos: hallazgos.length });
  return Buffer.from(contenido, 'utf8');
}
