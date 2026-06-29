import { v4 as uuidv4 } from 'uuid';
import { AppError } from './errors.js';
import { logger } from './logger.js';

export async function notificarAdminParaAprobacion(db, placa, pdfBuffer) {
  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new AppError('PDF vacío: no se puede enviar para aprobación', 422);
  }

  const token = uuidv4();
  await db.guardarTokenAprobacion(placa, token);
  await db.crearNotificacion(placa, 'APROBACION_PENDIENTE', `PDF listo para revisión. Token: ${token}`);

  logger.info('Admin notificado para aprobación de certificado', { placa });
  return { token, placa };
}

export async function procesarCallbackAprobacion(db, token) {
  const placa = await db.obtenerPlacaPorToken(token);
  if (!placa) {
    throw new AppError('Token de aprobación inválido o expirado', 401);
  }

  await db.marcarTokenUsado(token);
  await db.actualizarStatusOrden(placa, 'CERTIFICADO_APROBADO');
  await db.crearNotificacion(placa, 'CERTIFICADO_APROBADO', 'Certificado aprobado por el administrador');

  logger.success('Certificado aprobado', { placa });
  return { placa, status: 'APROBADO' };
}

export async function procesarCallbackCorreccion(db, token, notas = '') {
  const placa = await db.obtenerPlacaPorToken(token);
  if (!placa) {
    throw new AppError('Token de aprobación inválido o expirado', 401);
  }

  await db.marcarTokenUsado(token);
  await db.actualizarStatusOrden(placa, 'NECESITA_CORRECCION');
  await db.crearNotificacion(placa, 'NECESITA_CORRECCION', `Corrección solicitada: ${notas}`);

  logger.info('Corrección solicitada', { placa, notas });
  return { placa, status: 'NECESITA_CORRECCION' };
}
