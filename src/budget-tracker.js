import { PRICING_USD_PER_MTOK } from './model-router.js';
import { AppError } from './errors.js';

export const BUDGET_LIMIT_USD = Number(process.env.BUDGET_LIMIT_USD) || 150;
const DEGRADE_THRESHOLD = 0.8;

const DOWNGRADE_MAP = {
  'claude-opus-4-8': 'claude-sonnet-4-6',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-haiku-4-5': 'claude-haiku-4-5',
};

export function calcularCostoUSD(modelo, usage = {}) {
  const precios = PRICING_USD_PER_MTOK[modelo];
  if (!precios) {
    throw new Error(`Sin precios definidos para el modelo: ${modelo}`);
  }

  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;

  const costo =
    (inputTokens * precios.input +
      outputTokens * precios.output +
      cacheCreationTokens * precios.cacheWrite5m +
      cacheReadTokens * precios.cacheRead) /
    1_000_000;

  return costo;
}

function inicioDeMes() {
  const ahora = new Date();
  return new Date(ahora.getFullYear(), ahora.getMonth(), 1).toISOString();
}

export async function obtenerGastoMensual(db) {
  const filas = await db.obtenerGastoDesde(inicioDeMes());
  return filas.reduce((total, fila) => total + Number(fila.costo_estimado_usd), 0);
}

export async function verificarPresupuesto(db) {
  const gastoMensual = await obtenerGastoMensual(db);
  const porcentaje = gastoMensual / BUDGET_LIMIT_USD;

  let nivel = 'normal';
  if (porcentaje >= 1) {
    nivel = 'bloqueado';
  } else if (porcentaje >= DEGRADE_THRESHOLD) {
    nivel = 'degradado';
  }

  return { nivel, gastoMensual, porcentaje, limite: BUDGET_LIMIT_USD };
}

export function aplicarDegradacion(modelo, nivel) {
  if (nivel === 'bloqueado') {
    throw new AppError(
      `Presupuesto mensual agotado ($${BUDGET_LIMIT_USD} USD). Llamadas a Claude bloqueadas hasta el próximo mes o un aumento de presupuesto.`,
      402
    );
  }
  if (nivel === 'degradado') {
    return DOWNGRADE_MAP[modelo] || modelo;
  }
  return modelo;
}

export async function registrarLlamada(db, { rol, modelo, tipoTarea, usage, placa = null }) {
  const costoUsd = calcularCostoUSD(modelo, usage);
  await db.registrarCostoAPI({
    rol,
    modelo,
    tipoTarea,
    tokensInput: usage.input_tokens || 0,
    tokensOutput: usage.output_tokens || 0,
    tokensCacheCreation: usage.cache_creation_input_tokens || 0,
    tokensCacheRead: usage.cache_read_input_tokens || 0,
    costoUsd,
    placa,
  });
  return costoUsd;
}
