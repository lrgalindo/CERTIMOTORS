import axios from 'axios';
import { logger } from './logger.js';
import { AppError, ClaudeAPIError } from './errors.js';
import { seleccionarModeloPorRol } from './model-router.js';
import { verificarPresupuesto, aplicarDegradacion, registrarLlamada } from './budget-tracker.js';

async function ejecutarLlamadaClaude(apiKey, db, systemPrompt, messages, rol, placa, extra = {}) {
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
    const url = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
    const response = await axios.post(
      url,
      {
        model: modelo,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
        ...extra,
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        // Mayor que el default global: las respuestas largas de Claude pueden
        // tardar más de 15s, pero nunca deben colgar el job indefinidamente.
        timeout: Number(process.env.CLAUDE_TIMEOUT_MS) || 60000,
      }
    );

    const usage = response.data.usage || {};
    const costoUsd = await registrarLlamada(db, { rol, modelo, tipoTarea, usage, placa });
    logger.debug('Claude API response', { tokens: usage.output_tokens, modelo, rol, costoUsd });
    return response.data;
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    logger.error('Claude API error', { error: errorMsg, modelo, rol });
    throw new ClaudeAPIError(`Claude API: ${errorMsg}`, error);
  }
}

export async function llamarClaudeAPI(apiKey, db, systemPrompt, messages, rol, placa = null) {
  const data = await ejecutarLlamadaClaude(apiKey, db, systemPrompt, messages, rol, placa);
  return data.content?.[0]?.text || '';
}

// Fuerza tool_choice sobre el tool dado y devuelve su input ya parseado.
// Usado por los agentes Mecánico/Tramitador para extraer datos estructurados
// de lenguaje libre sin un segundo round-trip a Claude.
export async function llamarClaudeConTool(apiKey, db, systemPrompt, messages, rol, placa, tool) {
  const data = await ejecutarLlamadaClaude(apiKey, db, systemPrompt, messages, rol, placa, {
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  });

  const toolUse = data.content?.find((block) => block.type === 'tool_use');
  if (!toolUse) {
    throw new ClaudeAPIError('Claude no devolvió la llamada a herramienta esperada', null);
  }
  return toolUse.input;
}
