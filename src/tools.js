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
    'Registra actualizaciones de las 4 verificaciones administrativas obligatorias (impuesto de circulación, calcomanía electrónica, multas de tránsito, gravámenes de garantías mobiliarias) reportadas en este mensaje, y prepara la respuesta para el tramitador. Llamar siempre.',
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
            area: {
              type: 'string',
              enum: ['IMPUESTO_CIRCULACION', 'CALCOMANIA', 'MULTAS', 'GRAVAMENES'],
            },
            estado: {
              type: 'string',
              enum: [
                'SOLVENTE',
                'PENDIENTE',
                'VIGENTE',
                'VENCIDA',
                'SIN_MULTAS',
                'CON_MULTAS',
                'SIN_GRAVAMENES',
                'CON_GRAVAMENES',
                'NO_VERIFICADO',
              ],
            },
            detalle: { type: 'string' },
          },
        },
      },
      tramite_completo: { type: 'boolean', default: false },
      respuesta_tramitador: { type: 'string' },
    },
  },
};

export const CATEGORIAS_INSPECCION = [
  'MOTOR_TRANSMISION',
  'FRENOS_SUSPENSION',
  'DIRECCION_NEUMATICOS',
  'SISTEMA_ELECTRICO',
  'CARROCERIA_EXTERIOR',
  'INTERIOR_TAPICERIA',
  'DOCUMENTACION_ACCESORIOS',
  'FLUIDOS_FILTROS',
];

// Tool forzado en la única llamada a Haiku que dispara generarCertificado():
// clasifica cada punto reportado en una de las 8 categorías del PDF y
// traduce los hallazgos MAL/REGULAR a lenguaje de cliente.
export const TOOL_GENERAR_CERTIFICADO = {
  name: 'generar_certificado',
  description:
    'Clasifica cada punto de inspección reportado en su categoría, traduce los hallazgos críticos y de observación a lenguaje claro para el cliente final, y redacta los veredictos del certificado.',
  input_schema: {
    type: 'object',
    required: ['veredicto', 'categorias'],
    properties: {
      veredicto: {
        type: 'string',
        description: 'Párrafo de 3-4 líneas en español claro para el cliente final, no para el mecánico.',
      },
      atencion_inmediata: {
        type: 'array',
        default: [],
        description: 'Un ítem por cada punto en estado MAL, traducido a lenguaje de cliente.',
        items: {
          type: 'object',
          required: ['punto', 'descripcion'],
          properties: {
            punto: { type: 'integer', minimum: 1, maximum: 110 },
            descripcion: { type: 'string' },
          },
        },
      },
      observacion: {
        type: 'array',
        default: [],
        description: 'Un ítem por cada punto en estado REGULAR, traducido a lenguaje de cliente.',
        items: {
          type: 'object',
          required: ['punto', 'descripcion'],
          properties: {
            punto: { type: 'integer', minimum: 1, maximum: 110 },
            descripcion: { type: 'string' },
          },
        },
      },
      categorias: {
        type: 'array',
        description: 'Categoría asignada a cada punto reportado (BIEN, REGULAR o MAL), sin excepción.',
        items: {
          type: 'object',
          required: ['punto', 'categoria'],
          properties: {
            punto: { type: 'integer', minimum: 1, maximum: 110 },
            categoria: { type: 'string', enum: CATEGORIAS_INSPECCION },
          },
        },
      },
      veredicto_administrativo: {
        type: 'string',
        description:
          'Solo si se incluyeron verificaciones administrativas: párrafo de 2-3 líneas sobre si el vehículo está limpio para traspasar o tiene impedimentos.',
      },
    },
  },
};
