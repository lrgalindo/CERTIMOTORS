import { prompts } from './prompts.js';
import { llamarClaudeAPI } from './claude-client.js';
import { AppError } from './errors.js';

export async function validarOrden(db, apiKey, placa) {
  const orden = await db.obtenerOrdenPorPlaca(placa);
  if (!orden) {
    throw new AppError('Orden no encontrada', 404);
  }

  const revisiones = await db.obtenerRevisionesPorPlaca(placa);
  const completadas = new Set(revisiones.map((r) => r.punto_actual)).size;
  const porcentaje = Math.round((completadas / 110) * 100);

  const systemPrompt = prompts.construirSystemPromptValidator();
  const validacion = await llamarClaudeAPI(
    apiKey,
    db,
    systemPrompt,
    [
      {
        role: 'user',
        content: `Validar orden ${placa}: ${completadas}/110 puntos completados (${porcentaje}%)`,
      },
    ],
    'validator',
    placa
  );

  return { porcentaje, completadas, validacion };
}
