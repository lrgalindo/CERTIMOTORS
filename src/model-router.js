export const TASK_TYPES = {
  CLASIFICACION: 'clasificacion',
  CONVERSACION: 'conversacion',
  EXTRACCION: 'extraccion',
  RAZONAMIENTO_PROFUNDO: 'razonamiento_profundo',
};

export const ROLE_TASK_TYPE = {
  cliente: TASK_TYPES.CONVERSACION,
  mecanico: TASK_TYPES.EXTRACCION,
  tramitador: TASK_TYPES.CONVERSACION,
  validator: TASK_TYPES.RAZONAMIENTO_PROFUNDO,
  reporter: TASK_TYPES.RAZONAMIENTO_PROFUNDO,
};

const MODEL_BY_TASK_TYPE = {
  [TASK_TYPES.CLASIFICACION]: 'claude-haiku-4-5-20251001',
  [TASK_TYPES.CONVERSACION]: 'claude-sonnet-4-6',
  [TASK_TYPES.EXTRACCION]: 'claude-sonnet-4-6',
  [TASK_TYPES.RAZONAMIENTO_PROFUNDO]: 'claude-opus-4-8',
};

const MAX_TOKENS_BY_TASK_TYPE = {
  [TASK_TYPES.CLASIFICACION]: 200,
  [TASK_TYPES.CONVERSACION]: 1024,
  [TASK_TYPES.EXTRACCION]: 1024,
  [TASK_TYPES.RAZONAMIENTO_PROFUNDO]: 2048,
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
