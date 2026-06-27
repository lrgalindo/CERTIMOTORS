export const TOOL_REGISTRAR_INSPECCION = {
  name: 'registrar_inspeccion',
  description:
    'Registra los hallazgos de inspección reportados en este mensaje y prepara la respuesta para el mecánico. Llamar siempre, incluso si no hay hallazgos nuevos (ej. el mecánico solo hace una pregunta).',
  input_schema: {
    type: 'object',
    required: ['respuesta_mecanico'],
    properties: {
      hallazgos: {
        type: 'array',
        default: [],
        items: {
          type: 'object',
          required: ['punto', 'estado'],
          properties: {
            punto: { type: 'integer', minimum: 1, maximum: 110 },
            nombre_punto: { type: 'string' },
            estado: { type: 'string', enum: ['BIEN', 'REGULAR', 'MAL'] },
            observacion: { type: 'string' },
          },
        },
      },
      inspeccion_completa: { type: 'boolean', default: false },
      respuesta_mecanico: { type: 'string' },
    },
  },
};

export const TOOL_REGISTRAR_AVANCE_TRAMITE = {
  name: 'registrar_avance_tramite',
  description:
    'Registra actualizaciones del trámite administrativo reportadas en este mensaje y prepara la respuesta para el tramitador. Llamar siempre.',
  input_schema: {
    type: 'object',
    required: ['respuesta_tramitador'],
    properties: {
      actualizaciones: {
        type: 'array',
        default: [],
        items: {
          type: 'object',
          required: ['area', 'estado'],
          properties: {
            area: { type: 'string', enum: ['DOCUMENTOS', 'PAGO', 'SAT', 'MUNICIPIO', 'CERTIFICADO', 'OTRO'] },
            estado: { type: 'string', enum: ['PENDIENTE', 'EN_PROCESO', 'COMPLETADO', 'RECHAZADO'] },
            detalle: { type: 'string' },
          },
        },
      },
      tramite_completo: { type: 'boolean', default: false },
      respuesta_tramitador: { type: 'string' },
    },
  },
};
