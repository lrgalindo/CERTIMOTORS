/**
 * Genera dos PDFs de muestra usando el código real de pdf-generator.js.
 * Pasa por el mismo camino de código que una orden real:
 *   generarCertificado → llamarClaudeConTool → Claude API → todas las funciones de dibujo
 *
 * El único mock es el objeto `db` (base de datos), que devuelve datos sintéticos
 * en lugar de conectarse a Supabase.
 *
 * Uso:  node muestras-pdf/generar-muestras.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Cargar .env desde la raíz del proyecto
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: path.join(rootDir, '.env') });

// ─── Datos sintéticos ────────────────────────────────────────────────────────

const PLACA_BASICO = 'MLX7293';
const PLACA_FULL = 'BGT1482';

const ORDEN_BASE = {
  id: 'a1b2c3d4-0000-0000-0000-000000000001',
  tipo_auto: 'Sedán',
  color: 'Gris Oxford',
  chasis: 'JHMCG5659MC012345',
  motor: 'K20Z3-09876',
  marca: 'Honda',
  modelo: 'Civic EXL',
  anio: 2019,
  kilometraje: 87450,
  inspector_nombre: 'Mario Fuentes',
  created_at: new Date('2026-07-10T09:00:00-06:00').toISOString(),
  updated_at: new Date('2026-07-10T13:45:00-06:00').toISOString(),
};

// 110 puntos de inspección — mix realista: 2 MAL, 4 REGULAR, resto BIEN
// Formato de respuesta: "ESTADO - nombre_punto - observacion"
function buildRevisiones(baseTime) {
  const puntos = [
    // MOTOR_TRANSMISION (pts 1-15)
    [1,  'BIEN',    'Nivel de aceite de motor',           null],
    [2,  'BIEN',    'Color y viscosidad del aceite',       null],
    [3,  'MAL',     'Banda de distribución',               'Desgaste severo visible; requiere reemplazo inmediato antes de circular'],
    [4,  'BIEN',    'Correas accesorias',                  null],
    [5,  'BIEN',    'Mangueras de radiador',               null],
    [6,  'REGULAR', 'Radiador y sistema de enfriamiento',  'Pequeña oxidación en la parte inferior del radiador; monitorear'],
    [7,  'BIEN',    'Bomba de agua',                       null],
    [8,  'BIEN',    'Compresor de A/C',                    null],
    [9,  'BIEN',    'Caja de velocidades manual/automática',null],
    [10, 'BIEN',    'Junta homocinética y flechas',        null],
    [11, 'BIEN',    'Soporte de motor y caja',             null],
    [12, 'BIEN',    'Escape completo sin fugas',           null],
    [13, 'BIEN',    'Catalizador',                         null],
    [14, 'BIEN',    'Sistema de combustible (tanque, líneas)', null],
    [15, 'BIEN',    'Inyectores (vibración y fugas)',       null],

    // FRENOS_SUSPENSION (pts 16-30)
    [16, 'BIEN',    'Discos de freno delanteros',          null],
    [17, 'BIEN',    'Pastillas de freno delanteras',       null],
    [18, 'REGULAR', 'Discos de freno traseros',            'Desgaste uniforme pero en el límite; cambio preventivo recomendado en 5,000 km'],
    [19, 'BIEN',    'Pastillas de freno traseras',         null],
    [20, 'BIEN',    'Líquido de frenos (nivel y color)',   null],
    [21, 'BIEN',    'Mangueras de freno',                  null],
    [22, 'BIEN',    'Freno de mano (funcionamiento)',      null],
    [23, 'BIEN',    'Amortiguadores delanteros',           null],
    [24, 'BIEN',    'Amortiguadores traseros',             null],
    [25, 'BIEN',    'Resortes de suspensión',              null],
    [26, 'BIEN',    'Brazos de control y rótulas',         null],
    [27, 'REGULAR', 'Barra estabilizadora y bujes',        'Bujes con juego leve; reemplazar en la próxima revisión de mantenimiento'],
    [28, 'BIEN',    'Terminales de dirección',             null],
    [29, 'BIEN',    'Caja de dirección hidráulica/EPS',    null],
    [30, 'BIEN',    'Columna de dirección',                null],

    // DIRECCION_NEUMATICOS (pts 31-42)
    [31, 'BIEN',    'Neumático delantero derecho',         null],
    [32, 'BIEN',    'Neumático delantero izquierdo',       null],
    [33, 'BIEN',    'Neumático trasero derecho',           null],
    [34, 'BIEN',    'Neumático trasero izquierdo',         null],
    [35, 'BIEN',    'Llanta de repuesto',                  null],
    [36, 'BIEN',    'Presión de neumáticos',               null],
    [37, 'BIEN',    'Profundidad de la banda de rodamiento',null],
    [38, 'BIEN',    'Alineación (indicadores indirectos)', null],
    [39, 'BIEN',    'Volante centrado',                    null],
    [40, 'BIEN',    'Servo dirección (sin ruidos)',        null],
    [41, 'BIEN',    'Nivel de líquido de dirección',       null],
    [42, 'BIEN',    'Rines sin daños visibles',            null],

    // SISTEMA_ELECTRICO (pts 43-58)
    [43, 'BIEN',    'Batería (voltaje y estado)',          null],
    [44, 'BIEN',    'Alternador (carga)',                  null],
    [45, 'BIEN',    'Luces delanteras (baja)',             null],
    [46, 'BIEN',    'Luces delanteras (alta)',             null],
    [47, 'BIEN',    'Luces traseras y de freno',           null],
    [48, 'BIEN',    'Luces de reversa',                    null],
    [49, 'REGULAR', 'Luz de tablero (CEL apagada)',        'Luz de servicio de motor encendida; requiere diagnóstico OBD para determinar causa'],
    [50, 'BIEN',    'Intermitentes delanteros y traseros', null],
    [51, 'BIEN',    'Bocina',                              null],
    [52, 'BIEN',    'Limpiaparabrisas delanteros',        null],
    [53, 'BIEN',    'Limpiaparabrisas trasero',           null],
    [54, 'BIEN',    'Vidrios eléctricos (subida/bajada)', null],
    [55, 'BIEN',    'Sistema A/C (temperatura)',           null],
    [56, 'BIEN',    'Calefacción',                        null],
    [57, 'BIEN',    'Diagnóstico OBD-II (sin códigos activos)',null],
    [58, 'MAL',     'Fusibles e instalación eléctrica',   'Fusible de caja principal quemado y cableado con empalmes artesanales; riesgo de cortocircuito'],

    // CARROCERIA_EXTERIOR (pts 59-72)
    [59, 'BIEN',    'Capó (bisagras y sello)',             null],
    [60, 'BIEN',    'Parachoque delantero',                null],
    [61, 'BIEN',    'Guardafango delantero derecho',       null],
    [62, 'BIEN',    'Guardafango delantero izquierdo',     null],
    [63, 'BIEN',    'Puertas (alineación y sellos)',       null],
    [64, 'BIEN',    'Techo sin abolladuras',               null],
    [65, 'BIEN',    'Parachoque trasero',                  null],
    [66, 'BIEN',    'Maletero (bisagras y cierre)',        null],
    [67, 'BIEN',    'Vidrios (sin fisuras)',               null],
    [68, 'BIEN',    'Parabrisas (sin impactos de piedra críticos)', null],
    [69, 'BIEN',    'Espejo retrovisor izquierdo',        null],
    [70, 'BIEN',    'Espejo retrovisor derecho',          null],
    [71, 'BIEN',    'Pintura (uniformidad de color)',      null],
    [72, 'BIEN',    'Sellos anticorrosión',                null],

    // INTERIOR_TAPICERIA (pts 73-85)
    [73, 'BIEN',    'Asientos (ajuste y tapicería)',       null],
    [74, 'BIEN',    'Cinturones de seguridad',             null],
    [75, 'BIEN',    'Airbags (testigo apagado)',           null],
    [76, 'BIEN',    'Tablero sin roturas',                 null],
    [77, 'BIEN',    'Consola central',                     null],
    [78, 'BIEN',    'Alfombras y tapetes',                 null],
    [79, 'BIEN',    'Sunroof/techo corredizo',             null],
    [80, 'BIEN',    'Climatizador (mandos y pantalla)',    null],
    [81, 'BIEN',    'Sistema de audio',                    null],
    [82, 'BIEN',    'Conectividad USB/Bluetooth',          null],
    [83, 'BIEN',    'Cámara de reversa',                   null],
    [84, 'BIEN',    'Retrovisores interiores',             null],
    [85, 'BIEN',    'Pedales (acelerador, freno, embrague)',null],

    // DOCUMENTACION_ACCESORIOS (pts 86-96)
    [86, 'BIEN',    'Tarjeta de circulación vigente',     null],
    [87, 'BIEN',    'Manual del propietario',             null],
    [88, 'BIEN',    'Kit de herramientas',                null],
    [89, 'BIEN',    'Gato hidráulico',                    null],
    [90, 'BIEN',    'Triángulos de seguridad',            null],
    [91, 'BIEN',    'Extinguidor vigente',                null],
    [92, 'BIEN',    'Llaves (juego completo)',             null],
    [93, 'BIEN',    'Control remoto de alarma',           null],
    [94, 'BIEN',    'Tapones de rines',                   null],
    [95, 'BIEN',    'Parasol delantero',                  null],
    [96, 'BIEN',    'Alfombrillas de goma',               null],

    // FLUIDOS_FILTROS (pts 97-110)
    [97,  'BIEN',   'Aceite de transmisión automática',   null],
    [98,  'BIEN',   'Líquido de embrague',                null],
    [99,  'BIEN',   'Líquido de dirección hidráulica',    null],
    [100, 'BIEN',   'Líquido limpiaparabrisas',           null],
    [101, 'BIEN',   'Refrigerante (nivel y color)',        null],
    [102, 'BIEN',   'Filtro de aire (estado)',             null],
    [103, 'BIEN',   'Filtro de cabina (olor y estado)',    null],
    [104, 'BIEN',   'Filtro de combustible (antigüedad estimada)', null],
    [105, 'BIEN',   'Aceite de diferencial',              null],
    [106, 'BIEN',   'Fluido de caja de transferencia',    null],
    [107, 'BIEN',   'Líquido de freno (humedad)',         null],
    [108, 'BIEN',   'Sin fugas de aceite bajo el vehículo',null],
    [109, 'BIEN',   'Sin fugas de refrigerante',          null],
    [110, 'BIEN',   'Sin fugas de combustible',           null],
  ];

  return puntos.map(([punto, estado, nombre, obs], i) => ({
    id: `rev-${i + 1}`,
    punto_actual: punto,
    respuesta: obs ? `${estado} - ${nombre} - ${obs}` : `${estado} - ${nombre}`,
    created_at: new Date(baseTime.getTime() + i * 60000).toISOString(),
  }));
}

// Notificaciones administrativas para servicio FULL
const NOTIFICACIONES_FULL = [
  { tipo: 'IMPUESTO_CIRCULACION', mensaje: 'SOLVENTE: Impuesto de circulación pagado al corriente, vigente hasta dic 2026' },
  { tipo: 'CALCOMANIA',           mensaje: 'VIGENTE: Calcomanía electrónica activa, vence en noviembre 2026' },
  { tipo: 'MULTAS',               mensaje: 'SIN_MULTAS: Sin multas de tránsito registradas en Emetra y PMT' },
  { tipo: 'GRAVAMENES',           mensaje: 'CON_GRAVAMENES: Gravamen activo a favor de Entidad Financiera XYZ por préstamo vehicular; saldo pendiente aprox. Q28,500' },
];

// ─── DB fake ────────────────────────────────────────────────────────────────

function buildFakeDb(placa, servicio, outputPath) {
  const revisiones = buildRevisiones(new Date('2026-07-10T09:30:00-06:00'));

  return {
    async obtenerOrdenPorPlaca(p) {
      return {
        ...ORDEN_BASE,
        id: servicio === 'FULL' ? 'a1b2c3d4-0000-0000-0000-000000000002' : ORDEN_BASE.id,
        placa: p,
        servicio,
        status: servicio === 'FULL' ? 'TRAMITE_COMPLETO' : 'INSPECCION_COMPLETA',
      };
    },
    async obtenerRevisionesPorPlaca() {
      return revisiones;
    },
    async obtenerNotificacionesPorPlacaYTipos() {
      return NOTIFICACIONES_FULL;
    },
    async obtenerGastoDesde() {
      return [];
    },
    async registrarCostoAPI() {},
    async asegurarBucketCertificados() {},
    async subirCertificado(nombre, buffer) {
      fs.writeFileSync(outputPath, buffer);
      return outputPath;
    },
    async guardarCertificado() {},
    async obtenerFotosPorPlaca() {
      return [];
    },
    async descargarFoto() {
      throw new Error('sin fotos');
    },
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY no está definida. Asegurate de tener .env en la raíz del proyecto.');
    process.exit(1);
  }

  const { generarCertificado } = await import('../src/pdf-generator.js');

  const salidaBasico = path.join(__dirname, 'certificado-basico-muestra.pdf');
  const salidaFull   = path.join(__dirname, 'certificado-full-muestra.pdf');

  console.log('Generando certificado BÁSICO para', PLACA_BASICO, '…');
  const dbBasico = buildFakeDb(PLACA_BASICO, 'BASICO', salidaBasico);
  await generarCertificado(PLACA_BASICO, dbBasico);
  console.log('✓ BÁSICO →', salidaBasico);

  console.log('Generando certificado FULL para', PLACA_FULL, '…');
  const dbFull = buildFakeDb(PLACA_FULL, 'FULL', salidaFull);
  await generarCertificado(PLACA_FULL, dbFull);
  console.log('✓ FULL   →', salidaFull);

  console.log('\nListo. Abrí los archivos para revisar:');
  console.log(' ', salidaBasico);
  console.log(' ', salidaFull);
}

main().catch((err) => {
  console.error('Error al generar PDFs:', err.message || err);
  process.exit(1);
});
