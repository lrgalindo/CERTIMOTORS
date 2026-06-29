export const TASK_TYPES = {
  CLASIFICACION: 'clasificacion',
  CONVERSACION: 'conversacion',
  EXTRACCION: 'extraccion',
  RAZONAMIENTO_PROFUNDO: 'razonamiento_profundo',
  CERTIFICADO: 'certificado',
};

export const ROLE_TASK_TYPE = {
  cliente: TASK_TYPES.CONVERSACION,
  mecanico: TASK_TYPES.EXTRACCION,
  tramitador: TASK_TYPES.CONVERSACION,
  validator: TASK_TYPES.RAZONAMIENTO_PROFUNDO,
  reporter: TASK_TYPES.RAZONAMIENTO_PROFUNDO,
  certificado: TASK_TYPES.CERTIFICADO,
};

const MODEL_BY_TASK_TYPE = {
  [TASK_TYPES.CLASIFICACION]: 'claude-haiku-4-5',
  [TASK_TYPES.CONVERSACION]: 'claude-sonnet-4-6',
  [TASK_TYPES.EXTRACCION]: 'claude-sonnet-4-6',
  [TASK_TYPES.RAZONAMIENTO_PROFUNDO]: 'claude-opus-4-8',
  [TASK_TYPES.CERTIFICADO]: 'claude-haiku-4-5',
};

// USD por millón de tokens. Cache write: 1.25x (TTL 5m) / 2x (TTL 1h) del precio de input.
// Cache read: ~0.1x del precio de input. Verificado contra la documentación vigente de Anthropic.
export const PRICING_USD_PER_MTOK = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheWrite5m: 1.25, cacheWrite1h: 2.0, cacheRead: 0.1 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheWrite5m: 3.75, cacheWrite1h: 6.0, cacheRead: 0.3 },
  'claude-opus-4-8': { input: 5.0, output: 25.0, cacheWrite5m: 6.25, cacheWrite1h: 10.0, cacheRead: 0.5 },
};

const MAX_TOKENS_BY_TASK_TYPE = {
  [TASK_TYPES.CLASIFICACION]: 200,
  [TASK_TYPES.CONVERSACION]: 1024,
  [TASK_TYPES.EXTRACCION]: 1024,
  [TASK_TYPES.RAZONAMIENTO_PROFUNDO]: 2048,
  [TASK_TYPES.CERTIFICADO]: 4096,
};

export function seleccionarModelo(tipoTarea) {
  const modelo = MODEL_BY_TASK_TYPE[tipoTarea];
  if (!modelo) {
    throw new Error(`Tipo de tarea desconocido para el router de modelos: ${tipoTarea}`);
  }
  return modelo;
}

export function seleccionarMaxTokens(tipoTarea) {
  const maxTokens = MAX_TOKENS_BY_TASK_TYPE[tipoTarea];
  if (!maxTokens) {
    throw new Error(`Tipo de tarea desconocido para el router de modelos: ${tipoTarea}`);
  }
  return maxTokens;
}

export function seleccionarModeloPorRol(rol) {
  const tipoTarea = ROLE_TASK_TYPE[rol];
  if (!tipoTarea) {
    throw new Error(`Rol desconocido para el router de modelos: ${rol}`);
  }
  return { modelo: seleccionarModelo(tipoTarea), maxTokens: seleccionarMaxTokens(tipoTarea), tipoTarea };
}
