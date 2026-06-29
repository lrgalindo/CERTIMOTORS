import axios from 'axios';
import { logger } from './logger.js';
import { AppError, ClaudeAPIError } from './errors.js';
import { seleccionarModeloPorRol } from './model-router.js';
import { verificarPresupuesto, aplicarDegradacion, registrarLlamada } from './budget-tracker.js';

export async function llamarClaudeAPI(apiKey, db, systemPrompt, messages, rol, placa = null) {
  const presupuesto = await verificarPresupuesto(db);
  if (presupuesto.nivel === 'bloqueado') {
    logger.error('Presupuesto mensual agotado', presupuesto);
    throw new AppError(
      `Presupuesto mensual de Claude agotado ($${presupuesto.limite} USD, gasto actual $${presupuesto.gastoMensual.toFixed(2)}). Intenta más tarde.`,
      402
    );
  }

  const { modelo: modeloBase, maxTokens, tipoTarea } = seleccionarModeloPorRol(rol);
  const modelo = aplicarDegradacion(modeloBase, presupuesto.nivel);
  if (modelo !== modeloBase) {
    logger.warn('Modelo degradado por presupuesto', { rol, modeloBase, modelo, porcentaje: presupuesto.porcentaje });
  }

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: modelo,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );

    const texto = response.data.content[0]?.text || '';
    const usage = response.data.usage || {};

    const costoUsd = await registrarLlamada(db, { rol, modelo, tipoTarea, usage, placa });
    logger.debug('Claude API response', { tokens: usage.output_tokens, modelo, rol, costoUsd });
    return texto;
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    logger.error('Claude API error', { error: errorMsg, modelo, rol });
    throw new ClaudeAPIError(`Claude API: ${errorMsg}`, error);
  }
}
