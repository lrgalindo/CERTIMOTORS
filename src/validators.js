import { ValidationError } from './errors.js';

export function validatePlaca(placa) {
  if (!placa) throw new ValidationError('Placa es requerida');

  const placaRegex = /^[A-Z]\d{3}[A-Z]{3}$/;
  if (!placaRegex.test(placa)) {
    throw new ValidationError('Placa inválida. Formato: P926FTB');
  }

  return placa;
}

export function validatePhoneNumber(numero) {
  if (!numero) throw new ValidationError('Número de teléfono es requerido');

  const phoneRegex = /^\d{8,15}$/;
  if (!phoneRegex.test(numero.replace(/[^\d]/g, ''))) {
    throw new ValidationError('Número de teléfono inválido');
  }

  return numero;
}

export function validateTelegramId(id) {
  if (!id) throw new ValidationError('Telegram ID es requerido');
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new ValidationError('Telegram ID debe ser un número');
  }
  return id;
}

export function validateMessage(message) {
  if (!message) throw new ValidationError('Mensaje es requerido');
  if (typeof message !== 'string') {
    throw new ValidationError('Mensaje debe ser texto');
  }
  if (message.length > 4096) {
    throw new ValidationError('Mensaje muy largo (máx 4096 caracteres)');
  }
  return message.trim();
}

export function validatePuntoActual(punto) {
  if (punto === undefined || punto === null) {
    throw new ValidationError('Punto actual es requerido');
  }

  const puntoNum = parseInt(punto, 10);
  if (isNaN(puntoNum) || puntoNum < 1 || puntoNum > 110) {
    throw new ValidationError('Punto debe estar entre 1 y 110');
  }

  return puntoNum;
}
