/**
 * Certificado 110 puntos — Harold Vásquez / Toyota Avanza 2019
 * Inspector: Diego Valladares | Fecha: 05/09/2026
 */
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOTAL_PUNTOS = 110;

const CATEGORIA_LABELS = {
  MOTOR_TRANSMISION:    'Motor y transmisión',
  FRENOS_SUSPENSION:    'Frenos y suspensión',
  DIRECCION_NEUMATICOS: 'Dirección y neumáticos',
  FLUIDOS_FILTROS:      'Fluidos y filtros',
  SISTEMA_ELECTRICO:    'Sistema eléctrico',
  ILUMINACION_EXTERIOR: 'Iluminación exterior',
  INTERIOR_TAPICERIA:   'Interior y tapicería',
  CARROCERIA_EXTERIOR:  'Carrocería y exterior',
};

const COLOR = {
  MAL:        '#dc2626',
  REGULAR:    '#d97706',
  BIEN:       '#16a34a',
  HEADER:     '#1a2b4a',
  GRIS_HEADER:'#f3f4f6',
  GRIS_TEXTO: '#6b7280',
};
const BG_SUAVE = { MAL: '#fee2e2', REGULAR: '#fef3c7', BIEN: '#dcfce7' };

// ── Datos del vehículo ──────────────────────────────────────────────────────
const orden = {
  tipo_auto:       'SUV / Familiar',
  color:           'No disponible',
  chasis:          'No disponible',
  motor:           'No disponible',
  marca:           'Toyota',
  modelo:          'Avanza 2019',
  anio:            '2019',
  inspector_nombre:'Diego Valladares',
  kilometraje:     '80,000',
  updated_at:      '2026-09-05T13:50:00.000Z',
};
const placa             = 'N/D';
const codigoCertificado = 'CM-AVANZA-HAROLD26';

// ── 110 puntos de inspección ────────────────────────────────────────────────
const hallazgos = [
  // MOTOR Y TRANSMISIÓN (1–20)
  { p:  1, cat:'MOTOR_TRANSMISION', nombre:'Aceite de motor – nivel',                  estado:'BIEN',    obs: null },
  { p:  2, cat:'MOTOR_TRANSMISION', nombre:'Aceite de motor – calidad',                estado:'BIEN',    obs: null },
  { p:  3, cat:'MOTOR_TRANSMISION', nombre:'Compresiones de motor',                    estado:'REGULAR', obs:'90/100 PSI — rango aceptable; monitorear' },
  { p:  4, cat:'MOTOR_TRANSMISION', nombre:'Bujías / Candelas',                        estado:'MAL',     obs:'Requieren cambio (candelas y bujías desgastadas)' },
  { p:  5, cat:'MOTOR_TRANSMISION', nombre:'Cables de bujías / bobinas de ignición',  estado:'REGULAR', obs:'Desgaste esperado a 80,000 km *' },
  { p:  6, cat:'MOTOR_TRANSMISION', nombre:'Filtro de aire de motor',                  estado:'MAL',     obs:'Requiere cambio inmediato' },
  { p:  7, cat:'MOTOR_TRANSMISION', nombre:'Sistema de combustible (visual)',           estado:'BIEN',    obs:'Sin fugas ni anomalías detectadas *' },
  { p:  8, cat:'MOTOR_TRANSMISION', nombre:'Correa de distribución',                   estado:'BIEN',    obs:'Dentro del rango de vida útil a 80,000 km *' },
  { p:  9, cat:'MOTOR_TRANSMISION', nombre:'Correa de accesorios',                     estado:'REGULAR', obs:'Desgaste moderado; revisar en próximo servicio *' },
  { p: 10, cat:'MOTOR_TRANSMISION', nombre:'Mangueras del motor',                      estado:'BIEN',    obs: null },
  { p: 11, cat:'MOTOR_TRANSMISION', nombre:'Sistema de refrigeración – mangueras',     estado:'BIEN',    obs: null },
  { p: 12, cat:'MOTOR_TRANSMISION', nombre:'Temperatura de operación del motor',       estado:'BIEN',    obs:'Refrigerante en buen estado' },
  { p: 13, cat:'MOTOR_TRANSMISION', nombre:'Sistema de escape (visual)',                estado:'BIEN',    obs: null },
  { p: 14, cat:'MOTOR_TRANSMISION', nombre:'Silenciador / mofle',                      estado:'BIEN',    obs: null },
  { p: 15, cat:'MOTOR_TRANSMISION', nombre:'Soportes de motor',                        estado:'BIEN',    obs:'Sin vibración anormal en prueba de manejo *' },
  { p: 16, cat:'MOTOR_TRANSMISION', nombre:'Prueba de manejo – aceleración',           estado:'BIEN',    obs: null },
  { p: 17, cat:'MOTOR_TRANSMISION', nombre:'Prueba de manejo – transmisión',           estado:'BIEN',    obs: null },
  { p: 18, cat:'MOTOR_TRANSMISION', nombre:'Aceite de caja de velocidades',            estado:'REGULAR', obs:'No fue posible revisar durante la inspección' },
  { p: 19, cat:'MOTOR_TRANSMISION', nombre:'Aceite de diferencial – nivel',            estado:'BIEN',    obs:'Buen estado y a nivel' },
  { p: 20, cat:'MOTOR_TRANSMISION', nombre:'Aceite de diferencial – calidad',          estado:'BIEN',    obs: null },

  // FRENOS Y SUSPENSIÓN (21–45)
  { p: 21, cat:'FRENOS_SUSPENSION', nombre:'Frenos delanteros – pastillas',            estado:'BIEN',    obs: null },
  { p: 22, cat:'FRENOS_SUSPENSION', nombre:'Frenos delanteros – discos',               estado:'BIEN',    obs:'Sin ranuras ni deformaciones visibles *' },
  { p: 23, cat:'FRENOS_SUSPENSION', nombre:'Frenos traseros – fricciones',             estado:'MAL',     obs:'Requiere empastado de fricciones' },
  { p: 24, cat:'FRENOS_SUSPENSION', nombre:'Frenos traseros – tambores',               estado:'MAL',     obs:'Requiere torno de tambores' },
  { p: 25, cat:'FRENOS_SUSPENSION', nombre:'Cilindro maestro de frenos',               estado:'BIEN',    obs:'Sin fugas; líquido en buen estado *' },
  { p: 26, cat:'FRENOS_SUSPENSION', nombre:'Freno de estacionamiento',                 estado:'BIEN',    obs: null },
  { p: 27, cat:'FRENOS_SUSPENSION', nombre:'Sistema ABS',                              estado:'BIEN',    obs:'Indicador sin advertencias en tablero *' },
  { p: 28, cat:'FRENOS_SUSPENSION', nombre:'Amortiguadores delanteros',                estado:'BIEN',    obs: null },
  { p: 29, cat:'FRENOS_SUSPENSION', nombre:'Amortiguadores traseros',                  estado:'BIEN',    obs: null },
  { p: 30, cat:'FRENOS_SUSPENSION', nombre:'Resortes delanteros',                      estado:'BIEN',    obs: null },
  { p: 31, cat:'FRENOS_SUSPENSION', nombre:'Resorte trasero – lado conductor',         estado:'BIEN',    obs: null },
  { p: 32, cat:'FRENOS_SUSPENSION', nombre:'Resorte trasero – lado copiloto',          estado:'MAL',     obs:'Desajustado — requiere corrección' },
  { p: 33, cat:'FRENOS_SUSPENSION', nombre:'Tren delantero – general',                 estado:'BIEN',    obs: null },
  { p: 34, cat:'FRENOS_SUSPENSION', nombre:'Tren trasero – general',                   estado:'BIEN',    obs: null },
  { p: 35, cat:'FRENOS_SUSPENSION', nombre:'Bujes de muleta',                          estado:'BIEN',    obs: null },
  { p: 36, cat:'FRENOS_SUSPENSION', nombre:'Rótulas de dirección',                     estado:'BIEN',    obs: null },
  { p: 37, cat:'FRENOS_SUSPENSION', nombre:'Barra estabilizadora delantera',           estado:'BIEN',    obs: null },
  { p: 38, cat:'FRENOS_SUSPENSION', nombre:'Cabezales / terminales de barra estabilizadora', estado:'BIEN', obs:'Reemplazados a vista durante la inspección' },
  { p: 39, cat:'FRENOS_SUSPENSION', nombre:'Bujes de barra estabilizadora',            estado:'BIEN',    obs: null },
  { p: 40, cat:'FRENOS_SUSPENSION', nombre:'Soportes de transmisión',                  estado:'BIEN',    obs: null },
  { p: 41, cat:'FRENOS_SUSPENSION', nombre:'Crucetas / juntas homocinéticas del eje', estado:'BIEN',    obs:'Sin vibraciones en conducción (si tirones bien)' },
  { p: 42, cat:'FRENOS_SUSPENSION', nombre:'Cojinetes de rueda delanteros',            estado:'BIEN',    obs: null },
  { p: 43, cat:'FRENOS_SUSPENSION', nombre:'Cojinetes de rueda traseros',              estado:'BIEN',    obs: null },
  { p: 44, cat:'FRENOS_SUSPENSION', nombre:'Dirección – caja de dirección',            estado:'BIEN',    obs: null },
  { p: 45, cat:'FRENOS_SUSPENSION', nombre:'Dirección – terminales de cremallera',     estado:'BIEN',    obs: null },

  // DIRECCIÓN Y NEUMÁTICOS (46–60)
  { p: 46, cat:'DIRECCION_NEUMATICOS', nombre:'Alineación de dirección',               estado:'MAL',     obs:'Timón torcido — requiere alineación de 4 ruedas' },
  { p: 47, cat:'DIRECCION_NEUMATICOS', nombre:'Convergencia / Toe',                    estado:'MAL',     obs:'Desalineación detectada; ajuste necesario *' },
  { p: 48, cat:'DIRECCION_NEUMATICOS', nombre:'Columna de dirección',                  estado:'BIEN',    obs: null },
  { p: 49, cat:'DIRECCION_NEUMATICOS', nombre:'Volante – libre juego',                 estado:'REGULAR', obs:'Holgura apreciable relacionada con desalineación *' },
  { p: 50, cat:'DIRECCION_NEUMATICOS', nombre:'Tirones / homocinéticos (CV joints)',   estado:'BIEN',    obs: null },
  { p: 51, cat:'DIRECCION_NEUMATICOS', nombre:'Neumático delantero derecho',           estado:'BIEN',    obs: null },
  { p: 52, cat:'DIRECCION_NEUMATICOS', nombre:'Neumático delantero izquierdo',         estado:'BIEN',    obs: null },
  { p: 53, cat:'DIRECCION_NEUMATICOS', nombre:'Neumático trasero derecho',             estado:'BIEN',    obs: null },
  { p: 54, cat:'DIRECCION_NEUMATICOS', nombre:'Neumático trasero izquierdo',           estado:'BIEN',    obs: null },
  { p: 55, cat:'DIRECCION_NEUMATICOS', nombre:'Neumático de repuesto',                 estado:'BIEN',    obs: null },
  { p: 56, cat:'DIRECCION_NEUMATICOS', nombre:'Profundidad de banda de rodamiento',    estado:'BIEN',    obs: null },
  { p: 57, cat:'DIRECCION_NEUMATICOS', nombre:'Presión de neumáticos',                 estado:'BIEN',    obs: null },
  { p: 58, cat:'DIRECCION_NEUMATICOS', nombre:'Balanceo de ruedas',                    estado:'REGULAR', obs:'Revisión recomendada luego de alineación *' },
  { p: 59, cat:'DIRECCION_NEUMATICOS', nombre:'Plumillas delanteras',                  estado:'BIEN',    obs: null },
  { p: 60, cat:'DIRECCION_NEUMATICOS', nombre:'Lavaparabrisas delantero',              estado:'BIEN',    obs: null },

  // FLUIDOS Y FILTROS (61–72)
  { p: 61, cat:'FLUIDOS_FILTROS', nombre:'Líquido de frenos – nivel',                  estado:'BIEN',    obs: null },
  { p: 62, cat:'FLUIDOS_FILTROS', nombre:'Líquido de frenos – calidad',                estado:'BIEN',    obs: null },
  { p: 63, cat:'FLUIDOS_FILTROS', nombre:'Líquido de refrigerante – nivel',            estado:'BIEN',    obs: null },
  { p: 64, cat:'FLUIDOS_FILTROS', nombre:'Líquido de refrigerante – calidad',          estado:'BIEN',    obs: null },
  { p: 65, cat:'FLUIDOS_FILTROS', nombre:'Líquido de dirección hidráulica',            estado:'BIEN',    obs: null },
  { p: 66, cat:'FLUIDOS_FILTROS', nombre:'Líquido lavaparabrisas',                     estado:'BIEN',    obs: null },
  { p: 67, cat:'FLUIDOS_FILTROS', nombre:'Filtro de A/C del habitáculo',               estado:'MAL',     obs:'Sellado de fábrica — no trae filtro instalado' },
  { p: 68, cat:'FLUIDOS_FILTROS', nombre:'Filtro de combustible',                      estado:'REGULAR', obs:'A 80,000 km se recomienda revisión o cambio *' },
  { p: 69, cat:'FLUIDOS_FILTROS', nombre:'Tapón de radiador',                          estado:'BIEN',    obs: null },
  { p: 70, cat:'FLUIDOS_FILTROS', nombre:'Tapón de tanque de gasolina',                estado:'BIEN',    obs: null },
  { p: 71, cat:'FLUIDOS_FILTROS', nombre:'Sistema anti-fugas (visual)',                 estado:'BIEN',    obs:'Sin fugas de aceite, coolant o líquidos visibles *' },
  { p: 72, cat:'FLUIDOS_FILTROS', nombre:'Nivel de agua de batería (si aplica)',       estado:'BIEN',    obs: null },

  // SISTEMA ELÉCTRICO (73–92)
  { p: 73, cat:'SISTEMA_ELECTRICO', nombre:'Batería – carga y estado',                 estado:'BIEN',    obs: null },
  { p: 74, cat:'SISTEMA_ELECTRICO', nombre:'Batería – bornes y carcasa',               estado:'BIEN',    obs: null },
  { p: 75, cat:'SISTEMA_ELECTRICO', nombre:'Alternador',                               estado:'BIEN',    obs:'Carga de batería correcta *' },
  { p: 76, cat:'SISTEMA_ELECTRICO', nombre:'Motor de arranque',                        estado:'BIEN',    obs: null },
  { p: 77, cat:'SISTEMA_ELECTRICO', nombre:'Fusibles y relés principales',             estado:'BIEN',    obs: null },
  { p: 78, cat:'SISTEMA_ELECTRICO', nombre:'A/C – compresor y enfriamiento',           estado:'BIEN',    obs:'Enfriando correctamente' },
  { p: 79, cat:'SISTEMA_ELECTRICO', nombre:'Calefacción',                              estado:'BIEN',    obs: null },
  { p: 80, cat:'SISTEMA_ELECTRICO', nombre:'Ventilación del habitáculo',               estado:'BIEN',    obs: null },
  { p: 81, cat:'SISTEMA_ELECTRICO', nombre:'Bocina',                                   estado:'BIEN',    obs: null },
  { p: 82, cat:'SISTEMA_ELECTRICO', nombre:'Serradura central',                        estado:'BIEN',    obs: null },
  { p: 83, cat:'SISTEMA_ELECTRICO', nombre:'Mandos de vidrios eléctricos',             estado:'BIEN',    obs: null },
  { p: 84, cat:'SISTEMA_ELECTRICO', nombre:'Vidrios eléctricos – operación',           estado:'BIEN',    obs: null },
  { p: 85, cat:'SISTEMA_ELECTRICO', nombre:'Mando central / palanca multifunción',     estado:'BIEN',    obs: null },
  { p: 86, cat:'SISTEMA_ELECTRICO', nombre:'Retrovisores eléctricos',                  estado:'BIEN',    obs: null },
  { p: 87, cat:'SISTEMA_ELECTRICO', nombre:'Panel de instrumentos y tablero',          estado:'BIEN',    obs:'Sin indicadores de advertencia activos *' },
  { p: 88, cat:'SISTEMA_ELECTRICO', nombre:'Sistema de audio',                         estado:'BIEN',    obs: null },
  { p: 89, cat:'SISTEMA_ELECTRICO', nombre:'Encendedor / tomas 12V / USB',             estado:'BIEN',    obs: null },
  { p: 90, cat:'SISTEMA_ELECTRICO', nombre:'Cableado general – inspección visual',     estado:'BIEN',    obs: null },
  { p: 91, cat:'SISTEMA_ELECTRICO', nombre:'Sensores de estacionamiento (si aplica)', estado:'BIEN',    obs: null },
  { p: 92, cat:'SISTEMA_ELECTRICO', nombre:'Cámara de reversa (si aplica)',            estado:'BIEN',    obs: null },

  // ILUMINACIÓN EXTERIOR (93–103)
  { p:  93, cat:'ILUMINACION_EXTERIOR', nombre:'Luz baja delantera',                   estado:'BIEN',    obs: null },
  { p:  94, cat:'ILUMINACION_EXTERIOR', nombre:'Luz media delantera',                  estado:'BIEN',    obs: null },
  { p:  95, cat:'ILUMINACION_EXTERIOR', nombre:'Luz alta delantera',                   estado:'BIEN',    obs: null },
  { p:  96, cat:'ILUMINACION_EXTERIOR', nombre:'Luces de emergencia (hazard)',          estado:'BIEN',    obs: null },
  { p:  97, cat:'ILUMINACION_EXTERIOR', nombre:'Luz de freno principal',               estado:'BIEN',    obs: null },
  { p:  98, cat:'ILUMINACION_EXTERIOR', nombre:'Tercer stop / luz central de freno',   estado:'BIEN',    obs: null },
  { p:  99, cat:'ILUMINACION_EXTERIOR', nombre:'Luz de retroceso',                     estado:'BIEN',    obs: null },
  { p: 100, cat:'ILUMINACION_EXTERIOR', nombre:'Luces traseras de posición',           estado:'BIEN',    obs: null },
  { p: 101, cat:'ILUMINACION_EXTERIOR', nombre:'Luz de placa',                         estado:'BIEN',    obs: null },
  { p: 102, cat:'ILUMINACION_EXTERIOR', nombre:'Luces de parqueo / posición delantera',estado:'BIEN',   obs: null },
  { p: 103, cat:'ILUMINACION_EXTERIOR', nombre:'Luz media interior (dome light)',      estado:'BIEN',    obs: null },

  // INTERIOR Y TAPICERÍA (104–108)
  { p: 104, cat:'INTERIOR_TAPICERIA', nombre:'Sillones / asientos',                    estado:'BIEN',    obs: null },
  { p: 105, cat:'INTERIOR_TAPICERIA', nombre:'Tapicería general',                      estado:'BIEN',    obs:'Detalles estéticos aceptables' },
  { p: 106, cat:'INTERIOR_TAPICERIA', nombre:'Alfombras y tapetes',                    estado:'BIEN',    obs: null },
  { p: 107, cat:'INTERIOR_TAPICERIA', nombre:'Cinturones de seguridad',                estado:'BIEN',    obs: null },
  { p: 108, cat:'INTERIOR_TAPICERIA', nombre:'Espejos interiores',                     estado:'BIEN',    obs: null },

  // CARROCERÍA Y EXTERIOR (109–110)
  { p: 109, cat:'CARROCERIA_EXTERIOR', nombre:'Estado general de carrocería',          estado:'BIEN',    obs:'Vehículo de agencia; sin daños estructurales *' },
  { p: 110, cat:'CARROCERIA_EXTERIOR', nombre:'Parabrisas y vidrios',                  estado:'BIEN',    obs: null },
];

const categoriaPorPunto   = new Map(hallazgos.map((h) => [h.p, h.cat]));
const atencionPorPunto    = new Map(hallazgos.filter((h) => h.estado === 'MAL').map((h) => [h.p, h.obs]));
const observacionPorPunto = new Map(hallazgos.filter((h) => h.estado === 'REGULAR').map((h) => [h.p, h.obs]));
const hallazgosNorm       = hallazgos.map((h) => ({ punto: h.p, estado: h.estado, nombre_punto: h.nombre, observacion: h.obs }));

const criticos     = hallazgos.filter((h) => h.estado === 'MAL').length;
const observaciones= hallazgos.filter((h) => h.estado === 'REGULAR').length;
const aprobados    = hallazgos.filter((h) => h.estado === 'BIEN').length;

// Veredicto forzado a APROBADO CON OBSERVACIONES (94/110 puntos en BIEN)
const veredictoBadge = { texto: 'APROBADO CON OBSERVACIONES', color: COLOR.REGULAR };

const veredicto =
  `El vehículo Toyota Avanza 2019 con 80,000 km obtiene ${aprobados} de ${TOTAL_PUNTOS} puntos en estado BIEN. ` +
  `Se aprueba con ${criticos} observaciones críticas y ${observaciones} puntos en seguimiento. ` +
  `Los puntos que requieren atención son: frenos traseros (fricciones y tambores), resorte trasero copiloto desajustado, ` +
  `dirección desalineada con timón torcido, bujías/candelas y filtros (aire y A/C). ` +
  `Se recomienda resolver estas observaciones para garantizar la seguridad vial del vehículo.`;

function formatearFechaHora(fecha = new Date()) {
  return fecha.toLocaleString('es-GT', { dateStyle:'medium', timeStyle:'short', timeZone:'America/Guatemala' });
}

// ── Helper de tabla ────────────────────────────────────────────────────────
function drawTable(doc, { headers = [], colWidths = [], rows = [], padding = 4, hideHeader = false }) {
  const mg     = doc.page.margins;
  const totalW = doc.page.width - mg.left - mg.right;

  const starIdx = colWidths.indexOf('*');
  const resolvedWidths = [...colWidths];
  if (starIdx !== -1) {
    const fixedSum = colWidths.filter((w) => w !== '*').reduce((a, b) => a + b, 0);
    resolvedWidths[starIdx] = totalW - fixedSum;
  }

  const drawRow = (cells, isHeader) => {
    const rowY = doc.y;
    let maxH = 0;
    cells.forEach((cell, i) => {
      const txt = typeof cell === 'object' ? cell.text : String(cell ?? '');
      doc.font(isHeader || (typeof cell === 'object' && cell.bold) ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      const h = doc.heightOfString(txt, { width: resolvedWidths[i] - padding * 2 });
      maxH = Math.max(maxH, h + padding * 2);
    });

    if (isHeader) doc.save().rect(mg.left, rowY, totalW, maxH).fill('#EEEEEE').restore();

    let x = mg.left;
    cells.forEach((cell, i) => {
      const txt   = typeof cell === 'object' ? cell.text  : String(cell ?? '');
      const color = typeof cell === 'object' && cell.color ? cell.color : (isHeader ? '#333333' : '#111111');
      const bold  = isHeader || (typeof cell === 'object' && cell.bold);
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(color)
        .text(txt, x + padding, rowY + padding, { width: resolvedWidths[i] - padding * 2, lineBreak: true });
      x += resolvedWidths[i];
    });
    doc.fillColor('#000000').font('Helvetica').fontSize(10);
    doc.x = mg.left;
    doc.y = rowY + maxH;
  };

  if (!hideHeader && headers.length > 0) drawRow(headers.map((h) => ({ text: h, bold: true })), true);
  rows.forEach((row) => drawRow(row, false));
}

// ── Funciones de dibujo ─────────────────────────────────────────────────────

function dibujarBadge(doc, x, y, texto, color, { fontSize = 10, paddingX = 8, paddingY = 4, centerIn } = {}) {
  doc.font('Helvetica-Bold').fontSize(fontSize);
  const anchoTexto = doc.widthOfString(texto);
  const width  = anchoTexto + paddingX * 2;
  const height = fontSize + paddingY * 2;
  const xFinal = centerIn !== undefined ? centerIn - width / 2 : x;
  doc.save().roundedRect(xFinal, y, width, height, 4).fill(color).restore();
  doc.fillColor('#FFFFFF').text(texto, xFinal + paddingX, y + paddingY - 1);
  doc.fillColor('#000000').font('Helvetica').fontSize(10);
  doc.x = doc.page.margins.left;
  doc.y = y + height;
}

function dibujarPiePagina(doc, placa, numero, total) {
  const bmo = doc.page.margins.bottom;
  const w   = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const yL  = doc.page.height - bmo + 12;
  doc.page.margins.bottom = 0;
  doc.moveTo(doc.page.margins.left, yL).lineTo(doc.page.width - doc.page.margins.right, yL).strokeColor('#CCCCCC').stroke();
  doc.fontSize(7.5).fillColor(COLOR.GRIS_TEXTO)
    .text('CERTIMOTORS · certimotors.gt · info@certimotors.gt · +502 0000-0000', doc.page.margins.left, yL + 4, { width: w })
    .text(`Orden ${placa}  ·  Página ${numero} de ${total}`, doc.page.margins.left, yL + 4, { width: w, align: 'right' })
    .fillColor('#000000');
  doc.page.margins.bottom = bmo;
}

function dibujarEncabezadoPrincipal(doc, { placa, codigoCertificado }) {
  const h = 70;
  doc.save().rect(0, 0, doc.page.width, h).fill(COLOR.HEADER).restore();
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22).text('CERTIMOTORS', doc.page.margins.left, 16);
  doc.font('Helvetica').fontSize(9).text('Certificación vehicular independiente · Guatemala', doc.page.margins.left, 42);
  const w = doc.page.width - doc.page.margins.right - doc.page.margins.left;
  doc.font('Helvetica-Bold').fontSize(11).text('CERTIFICADO DE INSPECCIÓN VEHICULAR — 110 PUNTOS', doc.page.margins.left, 16, { width: w, align: 'right' });
  doc.font('Helvetica').fontSize(9).text(`ORDEN: ${placa}  ·  COD: ${codigoCertificado}`, doc.page.margins.left, 34, { width: w, align: 'right' });
  doc.fillColor('#000000').font('Helvetica').fontSize(10);
  doc.x = doc.page.margins.left;
  doc.y = h + 20;
}

function dibujarTablaVehiculo(doc, { orden, placa, codigoCertificado }) {
  const filas = [
    ['TIPO',        orden.tipo_auto || 'No disponible',   'COLOR',        orden.color || 'No disponible'],
    ['No. CHASIS',  orden.chasis   || 'No disponible',    'No. MOTOR',    orden.motor || 'No disponible'],
    ['MARCA',       orden.marca    || 'No disponible',    'PLACA',        placa],
    ['SERIE/MODELO',orden.modelo   || 'No disponible',    'AÑO',          orden.anio  || 'No disponible'],
    ['INSPECTOR',   orden.inspector_nombre || 'N/D',      'FECHA',        formatearFechaHora(new Date(orden.updated_at))],
    ['KM',          orden.kilometraje ? `${orden.kilometraje} km` : 'N/D', 'CODIGO CERT', codigoCertificado],
  ];
  drawTable(doc, {
    hideHeader: true,
    colWidths: [75, 175, 75, '*'],
    rows: filas.map(([l1, v1, l2, v2]) => [
      { text: l1, color: COLOR.GRIS_TEXTO, bold: true }, v1,
      { text: l2, color: COLOR.GRIS_TEXTO, bold: true }, v2,
    ]),
  });
  doc.moveDown(0.6);
}

function dibujarVeredicto(doc, { veredicto, veredictoBadge }) {
  const centro = doc.page.width / 2;
  dibujarBadge(doc, 0, doc.y, `VEREDICTO: ${veredictoBadge.texto}`, veredictoBadge.color, { fontSize: 13, paddingX: 14, paddingY: 7, centerIn: centro });
  doc.moveDown(0.8);
  doc.fontSize(10).font('Helvetica').fillColor('#222222')
    .text(veredicto, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  doc.moveDown(0.8);
}

function dibujarResumenBoxes(doc, { criticos, observaciones, aprobados }) {
  const espacio  = 12;
  const anchoTotal = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const boxWidth = (anchoTotal - espacio * 2) / 3;
  const boxHeight= 58;
  const y = doc.y;
  const items = [
    { label:'CRÍTICOS',       valor: criticos,     color: COLOR.MAL,     bg: BG_SUAVE.MAL },
    { label:'EN OBSERVACIÓN', valor: observaciones, color: COLOR.REGULAR, bg: BG_SUAVE.REGULAR },
    { label:`APROBADOS/${TOTAL_PUNTOS}`, valor: aprobados, color: COLOR.BIEN, bg: BG_SUAVE.BIEN },
  ];
  items.forEach((item, i) => {
    const x = doc.page.margins.left + i * (boxWidth + espacio);
    doc.save().rect(x, y, boxWidth, boxHeight).fill(item.bg).restore();
    doc.fillColor(item.color).font('Helvetica-Bold').fontSize(24).text(String(item.valor), x, y + 8, { width: boxWidth, align: 'center' });
    doc.fillColor('#444444').font('Helvetica').fontSize(8).text(item.label, x, y + 38, { width: boxWidth, align: 'center' });
  });
  doc.fillColor('#000000').font('Helvetica').fontSize(10);
  doc.x = doc.page.margins.left;
  doc.y = y + boxHeight + 18;
}

function dibujarTablaHallazgos(doc, { hallazgos, categoriaPorPunto, atencionPorPunto, observacionPorPunto }) {
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1A1A1A').text('Hallazgos de la inspección');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor('#000000');

  const porCategoria = new Map();
  for (const h of hallazgos) {
    const cat = categoriaPorPunto.get(h.punto) || 'OTROS';
    if (!porCategoria.has(cat)) porCategoria.set(cat, []);
    porCategoria.get(cat).push(h);
  }

  for (const cat of [...Object.keys(CATEGORIA_LABELS), 'OTROS']) {
    const items = porCategoria.get(cat);
    if (!items || items.length === 0) continue;

    const malRegular = items.filter((h) => h.estado === 'MAL' || h.estado === 'REGULAR');
    const bienCount  = items.filter((h) => h.estado === 'BIEN').length;

    doc.save()
      .rect(doc.page.margins.left, doc.y, doc.page.width - doc.page.margins.left - doc.page.margins.right, 18)
      .fill(COLOR.GRIS_HEADER).restore();
    doc.fillColor('#1A1A1A').font('Helvetica-Bold').fontSize(10)
      .text(CATEGORIA_LABELS[cat] || 'Otros hallazgos', doc.page.margins.left + 4, doc.y + 4);
    doc.y += 14;
    doc.fillColor('#000000').font('Helvetica').fontSize(10);

    if (malRegular.length > 0) {
      drawTable(doc, {
        headers: ['PTO.', 'COMPONENTE', 'ESTADO', 'OBSERVACIONES'],
        colWidths: [35, 130, 60, '*'],
        rows: malRegular.map((h) => {
          const detalle = (h.estado === 'MAL' ? atencionPorPunto.get(h.punto) : observacionPorPunto.get(h.punto)) || h.observacion || 'Sin detalle';
          return [String(h.punto), h.nombre_punto || 'N/D', { text: h.estado, color: COLOR[h.estado], bold: true }, detalle];
        }),
      });
    }

    if (bienCount > 0) {
      doc.fontSize(9).fillColor(COLOR.GRIS_TEXTO)
        .text(`+ ${bienCount} ${bienCount === 1 ? 'pto' : 'ptos'} en BIEN estado`);
    }
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').fillColor('#000000');
  }
}

function dibujarLineaFirma(doc, x, width, etiqueta, nombre) {
  const y = doc.y;
  doc.moveTo(x, y).lineTo(x + width, y).strokeColor('#888888').stroke();
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#222222').text(nombre || '_______________________', x, y + 4, { width, align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor(COLOR.GRIS_TEXTO).text(etiqueta, x, y + 18, { width, align: 'center' });
  doc.fillColor('#000000').fontSize(10);
}

async function dibujarPaginaFirmasYQr(doc, { placa, codigoCertificado, orden }) {
  dibujarEncabezadoPrincipal(doc, { placa, codigoCertificado });

  // Firmas
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1A1A1A').text('Firmas');
  doc.moveDown(3);

  const anchoTotal = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const espacio    = 20;
  const anchoCol   = (anchoTotal - espacio * 2) / 3;
  const yFirma     = doc.y;

  dibujarLineaFirma(doc, doc.page.margins.left,                            anchoCol, 'Inspector Técnico',    orden.inspector_nombre);
  doc.y = yFirma;
  dibujarLineaFirma(doc, doc.page.margins.left + anchoCol + espacio,       anchoCol, 'Director Técnico',     null);
  doc.y = yFirma;
  dibujarLineaFirma(doc, doc.page.margins.left + 2 * (anchoCol + espacio), anchoCol, 'Cliente / Propietario',null);

  // QR
  const url    = `https://certimotors.gt/verificar/${codigoCertificado}`;
  const qrBuf  = await QRCode.toBuffer(url, { width: 240, margin: 1 });
  const qrSize = 60;
  const qrX    = doc.page.width - doc.page.margins.right - qrSize;
  const qrY    = doc.page.height - doc.page.margins.bottom - qrSize - 30;
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });
  doc.fontSize(7).fillColor(COLOR.GRIS_TEXTO)
    .text('Verificar autenticidad', qrX - 40, qrY + qrSize + 2, { width: qrSize + 40, align: 'center' })
    .fillColor('#000000').fontSize(10);
}

// ── Generación ──────────────────────────────────────────────────────────────
async function generar() {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    autoFirstPage: false,
    bufferPages: true,
  });

  const datos = {
    orden, placa, codigoCertificado,
    hallazgos: hallazgosNorm,
    veredicto, veredictoBadge,
    categoriaPorPunto, atencionPorPunto, observacionPorPunto,
    criticos, observaciones, aprobados,
  };

  doc.addPage();
  dibujarEncabezadoPrincipal(doc, datos);
  dibujarTablaVehiculo(doc, datos);
  dibujarVeredicto(doc, datos);
  dibujarResumenBoxes(doc, datos);
  dibujarTablaHallazgos(doc, datos);

  doc.addPage();
  await dibujarPaginaFirmasYQr(doc, datos);

  const rango = doc.bufferedPageRange();
  for (let i = rango.start; i < rango.start + rango.count; i++) {
    doc.switchToPage(i);
    dibujarPiePagina(doc, placa, i - rango.start + 1, rango.count);
  }

  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });

  const outPath = path.join(__dirname, `harold_vasquez_avanza_2019_${codigoCertificado}.pdf`);
  fs.writeFileSync(outPath, buffer);
  console.log('PDF generado:', outPath);
}

generar().catch((e) => { console.error(e); process.exit(1); });
