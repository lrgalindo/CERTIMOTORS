// Máquina de estado explícita de la conversación de WhatsApp (cliente).
// El LLM conversa; ESTE módulo (código puro, sin IA) decide en qué etapa está
// la conversación y qué falta. El agente recibe `campos_faltantes` como
// contexto y decide cómo preguntarlo con naturalidad — nunca evalúa él mismo
// si una etapa está completa.

// Misma normalización que extraerPlaca (processors.js), local para mantener
// este módulo puro y sin ciclo de imports.
const normalizarPlaca = (texto) => {
  const m = String(texto).toUpperCase().match(/\b([A-Z])[ -]?(\d{3})[ -]?([A-Z]{3})\b/);
  return m ? m[1] + m[2] + m[3] : null;
};

// Zonas de cobertura con recargo (fuente: diseño del checkout web — la misma
// lista canónica de docs/API_CONTRACT_WEB.md).
export const ZONAS_COBERTURA = {
  MIXCO: 0,
  'VILLA NUEVA': 0,
  CHINAUTLA: 0,
  'SAN MIGUEL PETAPA': 75,
  'SANTA CATARINA PINULA': 75,
  'VILLA CANALES': 100,
  'SAN JOSÉ PINULA': 100,
  AMATITLÁN: 125,
  FRAIJANES: 125,
  CAPITAL: 0,
};

export const ETAPAS = [
  '0_bienvenida',
  '1_plan',
  '2_contacto',
  '3_vehiculo_zona',
  '4_agendamiento',
  '5_pago',
  '6_seguimiento',
];

// Campos requeridos para considerar completa cada etapa. La 0 y la 6 no piden
// campos: la 0 se completa con la primera interacción y la 6 es terminal (SAC).
const CAMPOS_POR_ETAPA = {
  '1_plan': ['plan_elegido'],
  '2_contacto': ['nombre', 'telefono_confirmado'],
  '3_vehiculo_zona': ['placa', 'marca', 'modelo', 'anio', 'zona', 'es_dueno'],
  '4_agendamiento': ['fecha_tentativa', 'hora_tentativa'],
  '5_pago': ['monto_confirmado'],
};

export function estadoInicial() {
  return {
    etapa: '0_bienvenida',
    persona_activa: 'sales',
    campos: {
      plan_elegido: null,
      nombre: null,
      telefono_confirmado: null,
      placa: null,
      marca: null,
      modelo: null,
      anio: null,
      zona: null,
      es_dueno: null,
      fecha_tentativa: null,
      hora_tentativa: null,
      upsell_segunda_inspeccion: false,
      monto_confirmado: false,
    },
  };
}

// Validadores por campo: el dato del agente solo se escribe si pasa. Devuelven
// el valor normalizado o undefined (= descartar sin escribir).
const VALIDADORES = {
  plan_elegido: (v) => (['BASICO', 'FULL'].includes(String(v).toUpperCase()) ? String(v).toUpperCase() : undefined),
  nombre: (v) => (String(v).trim().length >= 2 ? String(v).trim().slice(0, 120) : undefined),
  telefono_confirmado: (v) => (/^\d{8,15}$/.test(String(v).replace(/\D/g, '')) ? String(v).replace(/\D/g, '') : undefined),
  placa: (v) => normalizarPlaca(v) || undefined,
  marca: (v) => (String(v).trim() ? String(v).trim().slice(0, 60) : undefined),
  modelo: (v) => (String(v).trim() ? String(v).trim().slice(0, 60) : undefined),
  anio: (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1950 && n <= new Date().getFullYear() + 1 ? n : undefined;
  },
  zona: (v) => {
    const z = String(v).trim().toUpperCase();
    // "zona 10" y variantes del municipio capital cuentan como CAPITAL.
    if (/^ZONA\s*\d{1,2}$/.test(z) || z === 'GUATEMALA' || z === 'CIUDAD DE GUATEMALA') return 'CAPITAL';
    return Object.keys(ZONAS_COBERTURA).includes(z) ? z : undefined;
  },
  es_dueno: (v) => (['true', 'si', 'sí'].includes(String(v).toLowerCase()) ? true : ['false', 'no'].includes(String(v).toLowerCase()) ? false : undefined),
  fecha_tentativa: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || String(v).toLowerCase() === 'sin_fecha' ? String(v).toLowerCase() : undefined),
  hora_tentativa: (v) => (String(v).trim() ? String(v).trim().slice(0, 40) : undefined),
};

// Señales [DATO:campo=valor] del agente. Solo campos conocidos y valores que
// pasan validación; el resto se descarta en silencio (el agente re-pregunta).
export function extraerDatos(respuesta) {
  const datos = {};
  for (const m of respuesta.matchAll(/\[DATO:([a-z_]+)=([^\]]+)\]/g)) {
    const [, campo, crudo] = m;
    const validador = VALIDADORES[campo];
    if (!validador) continue;
    const valor = validador(crudo.trim());
    if (valor !== undefined) datos[campo] = valor;
  }
  const texto = respuesta.replace(/\s*\[DATO:[a-z_]+=[^\]]+\]/g, '').trim();
  return { texto, datos };
}

// Un campo está incompleto si es null; monto_confirmado además exige true
// (es_dueno=false es una respuesta válida y completa — "no soy el dueño").
const campoIncompleto = (campos, c) => (c === 'monto_confirmado' ? campos[c] !== true : campos[c] === null);

// Aplica datos nuevos y recalcula etapa/persona. Nunca retrocede campos ya
// confirmados (un dato solo se sobreescribe con otro valor válido).
export function actualizarEstado(estado, datosNuevos = {}) {
  // Un JSONB editado a mano sin .campos no debe mandar al cliente a 6_seguimiento.
  const campos = { ...estadoInicial().campos, ...estado?.campos, ...datosNuevos };

  let etapa = '6_seguimiento';
  for (const e of ETAPAS.slice(1, 6)) {
    if (CAMPOS_POR_ETAPA[e].some((c) => campoIncompleto(campos, c))) {
      etapa = e;
      break;
    }
  }

  return { etapa, persona_activa: etapa === '6_seguimiento' ? 'sac' : 'sales', campos };
}

export function camposFaltantes(estado) {
  const requeridos = CAMPOS_POR_ETAPA[estado.etapa] || [];
  return requeridos.filter((c) => campoIncompleto(estado.campos, c));
}

// Bloque de contexto que se inyecta al system prompt del cliente. El resto del
// prompt no cambia (decisión: persona única, opción a).
export function contextoParaPrompt(estado) {
  const faltantes = camposFaltantes(estado);
  return [
    `- Fase de la conversación: ${estado.etapa} (${estado.persona_activa === 'sac' ? 'postventa — el cliente ya está en proceso, resolvé dudas y estado' : 'venta — ayudalo a decidir y completar su solicitud'}).`,
    faltantes.length
      ? `- Datos que aún faltan para avanzar: ${faltantes.join(', ')}. Conseguilos con naturalidad cuando fluya — NO como interrogatorio, y nunca repitas una pregunta ya respondida.`
      : '- No falta ningún dato de esta fase.',
    `- Cuando el cliente te dé uno de esos datos DE FORMA CLARA, dejá la señal [DATO:campo=valor] al final de tu mensaje (ej. [DATO:anio=2019] [DATO:zona=MIXCO]). Si el dato vino ambiguo ("como del 2019 creo"), confirmalo primero y emití la señal solo cuando lo confirme.`,
  ].join('\n');
}
