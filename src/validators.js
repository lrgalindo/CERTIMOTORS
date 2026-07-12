import { AppError } from './errors.js';

const PLACA_REGEX = /^[A-Z]\d{3}[A-Z]{3}$/;

export function validatePlaca(placa) {
  if (!placa || typeof placa !== 'string' || !PLACA_REGEX.test(placa)) {
    throw new AppError('Placa inválida (formato esperado: P926FTB)', 400);
  }
}

export function validatePhoneNumber(numero) {
  if (!numero || typeof numero !== 'string' || !/^\d{8,15}$/.test(numero)) {
    throw new AppError('Número de teléfono inválido', 400);
  }
}

export function validateMessage(message) {
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new AppError('Mensaje inválido o vacío', 400);
  }
}
