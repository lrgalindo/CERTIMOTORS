import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { prompts } from './prompts.js';
import { llamarClaudeConTool } from './claude-client.js';
import { TOOL_GENERAR_CERTIFICADO } from './tools.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';

const TOTAL_PUNTOS = 110;

const AREAS_ADMIN = ['IMPUESTO_CIRCULACION', 'CALCOMANIA', 'MULTAS', 'GRAVAMENES'];
const ESTADOS_LIMPIOS = ['SOLVENTE', 'VIGENTE', 'SIN_MULTAS', 'SIN_GRAVAMENES'];

const AREA_LABELS = {
  IMPUESTO_CIRCULACION: 'Impuesto de circulación',
  CALCOMANIA: 'Calcomanía electrónica',
  MULTAS: 'Multas de tránsito',
  GRAVAMENES: 'Gravámenes de garantías mobiliarias',
};

// El cliente nunca debe ver los enums internos (SIN_MULTAS, NO_VERIFICADO, etc.)
const ESTADO_LABELS = {
  SOLVENTE: 'Solvente',
  PENDIENTE: 'Pendiente',
  VIGENTE: 'Vigente',
  VENCIDA: 'Vencida',
  SIN_MULTAS: 'Sin multas',
  CON_MULTAS: 'Con multas',
  SIN_GRAVAMENES: 'Sin gravámenes',
  CON_GRAVAMENES: 'Con gravámenes',
  NO_VERIFICADO: 'No verificado',
};

const CATEGORIA_LABELS = {
  MOTOR_TRANSMISION: 'Motor y transmisión',
  FRENOS_SUSPENSION: 'Frenos y suspensión',
  DIRECCION_NEUMATICOS: 'Dirección y neumáticos',
  SISTEMA_ELECTRICO: 'Sistema eléctrico',
  CARROCERIA_EXTERIOR: 'Carrocería exterior',
  INTERIOR_TAPICERIA: 'Interior y tapicería',
  DOCUMENTACION_ACCESORIOS: 'Documentación y accesorios',
  FLUIDOS_FILTROS: 'Fluidos y filtros',
};

const COLOR = {
  MAL: '#dc2626',
  REGULAR: '#d97706',
  BIEN: '#16a34a',
  HEADER: '#1a2b4a',
  GRIS_HEADER: '#f3f4f6',
  GRIS_TEXTO: '#6b7280',
};

const BG_SUAVE = { MAL: '#fee2e2', REGULAR: '#fef3c7', BIEN: '#dcfce7' };

function formatearFechaHora(fecha = new Date()) {
  return fecha.toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Guatemala' });
}

function generarCodigoCertificado(orden) {
  const sufijo = (orden.id || '').toString().replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || Date.now().toString(36).toUpperCase();
  return `CM-${orden.placa}-${sufijo}`;
}

// Cada hallazgo se guarda en revisiones como "ESTADO - nombre_punto - observacion"
// (ver processors.js). Un punto puede reportarse más de una vez (correcciones del
// mecánico); nos quedamos con el reporte más reciente por punto.
function dedupRevisiones(revisiones) {
  const porPunto = new Map();
  const ordenadas = [...revisiones].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const r of ordenadas) {
    const [estado, nombrePunto, ...resto] = (r.respuesta || '').split(' - ');
    porPunto.set(r.punto_actual, {
      punto: r.punto_actual,
      estado: estado?.trim(),
      nombre_punto: nombrePunto?.trim() || null,
      observacion: resto.join(' - ').trim() || null,
    });
  }
  return [...porPunto.values()].sort((a, b) => a.punto - b.punto);
}

// Las notificaciones de trámite se guardan como tipo=area, mensaje="ESTADO: detalle"
// (ver processors.js). Nos quedamos con el reporte más reciente por área; las áreas
// nunca reportadas quedan como NO_VERIFICADO.
function construirVerificaciones(notificaciones) {
  const porArea = new Map();
  for (const n of notificaciones) {
    if (porArea.has(n.tipo)) continue;
    const [estado, ...resto] = (n.mensaje || '').split(': ');
    porArea.set(n.tipo, { area: n.tipo, estado: estado?.trim() || 'NO_VERIFICADO', detalle: resto.join(': ').trim() || null });
  }
  return AREAS_ADMIN.map((area) => porArea.get(area) || { area, estado: 'NO_VERIFICADO', detalle: null });
}

// 3+ hallazgos MAL simultáneos se considera una condición de seguridad que
// impide circular (no un punto crítico aislado) y amerita NO APROBADO.
const UMBRAL_NO_APROBADO_CRITICOS = 3;

function calcularVeredicto(criticos, observaciones) {
  if (criticos >= UMBRAL_NO_APROBADO_CRITICOS) return { texto: 'NO APROBADO', color: COLOR.MAL };
  if (criticos > 0 || observaciones > 0) return { texto: 'APROBADO CON OBSERVACIONES', color: COLOR.REGULAR };
  return { texto: 'APROBADO', color: COLOR.BIEN };
}

function dibujarBadge(doc, x, y, texto, color, { fontSize = 10, paddingX = 8, paddingY = 4, centerIn } = {}) {
  doc.font('Helvetica-Bold').fontSize(fontSize);
  const anchoTexto = doc.widthOfString(texto);
  const width = anchoTexto + paddingX * 2;
  const height = fontSize + paddingY * 2;
  const xFinal = centerIn !== undefined ? centerIn - width / 2 : x;
  doc.save().roundedRect(xFinal, y, width, height, 4).fill(color).restore();
  doc.fillColor('#FFFFFF').text(texto, xFinal + paddingX, y + paddingY - 1);
  // .text() con x/y explícitos deja doc.x en esa posición; sin restaurarlo al
  // margen, el siguiente texto fluido hereda ese x y se desborda fuera de la
  // página (se ve "cortado" aunque pdfkit no aplique elipsis).
  doc.fillColor('#000000').font('Helvetica').fontSize(10);
  doc.x = doc.page.margins.left;
  doc.y = y + height;
  return { x: xFinal, width, height };
}

function dibujarPiePagina(doc, placa, numero, total) {
  const bottomMarginOriginal = doc.page.margins.bottom;
  const anchoUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const yLinea = doc.page.height - bottomMarginOriginal + 12;

  // El pie cae dentro del margen inferior reservado; sin anular el margen aquí,
  // pdfkit interpreta que no cabe y dispara un salto de página dentro del propio
  // ciclo de dibujo (recursión/estado inconsistente si se hace vía 'pageAdded').
  doc.page.margins.bottom = 0;
  doc.moveTo(doc.page.margins.left, yLinea).lineTo(doc.page.width - doc.page.margins.right, yLinea).strokeColor('#CCCCCC').stroke();
  doc
    .fontSize(7.5)
    .fillColor(COLOR.GRIS_TEXTO)
    .text('CERTIMOTORS · certimotors.gt · info@certimotors.gt · +502 0000-0000', doc.page.margins.left, yLinea + 4, {
      width: anchoUtil,
    })
    .text(`Orden ${placa}  ·  Página ${numero} de ${total}`, doc.page.margins.left, yLinea + 4, { width: anchoUtil, align: 'right' })
    .fillColor('#000000');
  doc.page.margins.bottom = bottomMarginOriginal;
}

function dibujarEncabezadoPrincipal(doc, { placa, codigoCertificado }) {
  const alturaBanda = 70;
  doc.save().rect(0, 0, doc.page.width, alturaBanda).fill(COLOR.HEADER).restore();

  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22).text('CERTIMOTORS', doc.page.margins.left, 16);
  doc.font('Helvetica').fontSize(9).text('Certificación vehicular independiente · Guatemala', doc.page.margins.left, 42);

  const anchoDerecha = doc.page.width - doc.page.margins.right - doc.page.margins.left;
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .text('CERTIFICADO DE INSPECCIÓN VEHICULAR — 110 PUNTOS', doc.page.margins.left, 16, { width: anchoDerecha, align: 'right' });
  doc
    .font('Helvetica')
    .fontSize(9)
    .text(`ORDEN: ${placa}  ·  COD: ${codigoCertificado}`, doc.page.margins.left, 34, { width: anchoDerecha, align: 'right' });

  doc.fillColor('#000000').font('Helvetica').fontSize(10);
  doc.x = doc.page.margins.left;
  doc.y = alturaBanda + 20;
}

function dibujarTablaVehiculo(doc, { orden, placa, codigoCertificado }) {
  const filas = [
    ['TIPO', orden.tipo_auto || 'No disponible', 'COLOR', orden.color || 'No disponible'],
    ['No. CHASIS', orden.chasis || 'No disponible', 'No. MOTOR', orden.motor || 'No disponible'],
    ['MARCA', orden.marca || 'No disponible', 'PLACA', placa],
    ['SERIE/MODELO', orden.modelo || 'No disponible', 'AÑO', orden.anio || 'No disponible'],
    ['INSPECTOR', orden.inspector_nombre || 'No disponible', 'FECHA', formatearFechaHora(new Date(orden.updated_at || orden.created_at))],
    ['KM', orden.kilometraje ? `${orden.kilometraje} km` : 'No disponible', 'CODIGO CERT', codigoCertificado],
  ];

  doc.table({
    data: filas.map(([l1, v1, l2, v2]) => [
      { text: l1, font: { family: 'Helvetica-Bold' }, textColor: COLOR.GRIS_TEXTO },
      v1,
      { text: l2, font: { family: 'Helvetica-Bold' }, textColor: COLOR.GRIS_TEXTO },
      v2,
    ]),
    columnStyles: [{ width: 75 }, { width: 175 }, { width: 75 }, { width: '*' }],
    padding: 4,
  });
  doc.moveDown(0.6);
}

function dibujarVeredicto(doc, { veredicto, veredictoBadge }) {
  const centro = doc.page.width / 2;
  dibujarBadge(doc, 0, doc.y, `VEREDICTO: ${veredictoBadge.texto}`, veredictoBadge.color, { fontSize: 13, paddingX: 14, paddingY: 7, centerIn: centro });
  doc.moveDown(0.8);

  // Sin width fijo de altura: pdfkit ajusta el alto del bloque al contenido real.
  doc.fontSize(10).font('Helvetica').fillColor('#222222').text(veredicto || 'Sin información suficiente para emitir un veredicto.', {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
  });
  doc.moveDown(0.8);
}

function dibujarResumenBoxes(doc, { criticos, observaciones, aprobados }) {
  const espacio = 12;
  const anchoTotal = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const boxWidth = (anchoTotal - espacio * 2) / 3;
  const boxHeight = 58;
  const y = doc.y;

  const items = [
    { label: 'CRÍTICOS', valor: criticos, color: COLOR.MAL, bg: BG_SUAVE.MAL },
    { label: 'EN OBSERVACIÓN', valor: observaciones, color: COLOR.REGULAR, bg: BG_SUAVE.REGULAR },
    { label: `APROBADOS/${TOTAL_PUNTOS}`, valor: aprobados, color: COLOR.BIEN, bg: BG_SUAVE.BIEN },
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
    const categoria = categoriaPorPunto.get(h.punto) || 'OTROS';
    if (!porCategoria.has(categoria)) porCategoria.set(categoria, []);
    porCategoria.get(categoria).push(h);
  }

  const ordenCategorias = [...Object.keys(CATEGORIA_LABELS), 'OTROS'];
  for (const categoria of ordenCategorias) {
    const items = porCategoria.get(categoria);
    if (!items || items.length === 0) continue;

    const malRegular = items.filter((h) => h.estado === 'MAL' || h.estado === 'REGULAR');
    const bienCount = items.filter((h) => h.estado === 'BIEN').length;

    doc
      .save()
      .rect(doc.page.margins.left, doc.y, doc.page.width - doc.page.margins.left - doc.page.margins.right, 18)
      .fill(COLOR.GRIS_HEADER)
      .restore();
    doc
      .fillColor('#1A1A1A')
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(CATEGORIA_LABELS[categoria] || 'Otros hallazgos', doc.page.margins.left + 4, doc.y + 4);
    doc.y += 14;
    doc.fillColor('#000000').font('Helvetica').fontSize(10);

    if (malRegular.length > 0) {
      doc.table({
        data: [
          ['PTO.', 'COMPONENTE', 'ESTADO', 'OBSERVACIONES'],
          ...malRegular.map((h) => {
            const detalle = (h.estado === 'MAL' ? atencionPorPunto.get(h.punto) : observacionPorPunto.get(h.punto)) || h.observacion || 'Sin detalle';
            return [
              String(h.punto),
              h.nombre_punto || 'N/D',
              { text: h.estado, textColor: COLOR[h.estado] || '#000000', font: { family: 'Helvetica-Bold' } },
              detalle,
            ];
          }),
        ],
        rowStyles: (i) => (i === 0 ? { font: { family: 'Helvetica-Bold' }, backgroundColor: '#EEEEEE' } : {}),
        columnStyles: [{ width: 35 }, { width: 110 }, { width: 60 }, { width: '*' }],
        padding: 4,
      });
    }

    if (bienCount > 0) {
      doc
        .fontSize(9)
        .fillColor(COLOR.GRIS_TEXTO)
        .text(`+ ${bienCount} ${bienCount === 1 ? 'pto' : 'ptos'} en BIEN estado`);
    }
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').fillColor('#000000');
  }
}

function dibujarPagina1(doc, datos) {
  dibujarEncabezadoPrincipal(doc, datos);
  dibujarTablaVehiculo(doc, datos);
  dibujarVeredicto(doc, datos);
  dibujarResumenBoxes(doc, datos);
  dibujarTablaHallazgos(doc, datos);
}

function dibujarPagina2(doc, { placa, codigoCertificado, verificaciones, veredictoAdministrativo }) {
  dibujarEncabezadoPrincipal(doc, { placa, codigoCertificado });

  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1A1A1A').text('Parte 2 — Verificación administrativa');
  doc.moveDown(0.4);

  const todasLimpias = verificaciones.every((v) => ESTADOS_LIMPIOS.includes(v.estado));
  const badgeAdmin = todasLimpias ? { texto: 'APTO PARA TRASPASO', color: COLOR.BIEN } : { texto: 'CON IMPEDIMENTOS', color: COLOR.MAL };
  dibujarBadge(doc, doc.page.margins.left, doc.y, badgeAdmin.texto, badgeAdmin.color, { fontSize: 11, paddingX: 12, paddingY: 6 });
  doc.moveDown(1.2);

  doc.table({
    data: [
      ['Verificación', 'Detalle', 'Estado'],
      ...verificaciones.map((v) => [
        AREA_LABELS[v.area],
        v.detalle || '—',
        {
          text: ESTADO_LABELS[v.estado] || v.estado,
          textColor: ESTADOS_LIMPIOS.includes(v.estado) ? COLOR.BIEN : v.estado === 'NO_VERIFICADO' ? COLOR.GRIS_TEXTO : COLOR.MAL,
          font: { family: 'Helvetica-Bold' },
        },
      ]),
    ],
    rowStyles: (i) => (i === 0 ? { font: { family: 'Helvetica-Bold' }, backgroundColor: '#EEEEEE' } : {}),
    columnStyles: [{ width: 150 }, { width: '*' }, { width: 100 }],
    padding: 5,
  });

  doc.moveDown(0.8);
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#1A1A1A').text('Dictamen');
  doc.moveDown(0.3);

  const xCaja = doc.page.margins.left;
  const anchoCaja = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const yCaja = doc.y;
  const textoDictamen = veredictoAdministrativo || 'Sin información suficiente para emitir un dictamen administrativo.';
  doc.font('Helvetica').fontSize(10);
  const alturaTexto = doc.heightOfString(textoDictamen, { width: anchoCaja - 16 });
  doc.save().rect(xCaja, yCaja, 4, alturaTexto + 16).fill(COLOR.HEADER).restore();
  doc.fillColor('#222222').text(textoDictamen, xCaja + 12, yCaja + 8, { width: anchoCaja - 16 });
  doc.y = yCaja + alturaTexto + 20;
  doc.fillColor('#000000');
}

function dibujarSeccionGarantia(doc, { codigoCertificado }) {
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1A1A1A').text('Garantía CERTIMOTORS');
  doc.moveDown(0.3);

  const xCaja = doc.page.margins.left;
  const anchoCaja = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const yCaja = doc.y;
  const texto =
    `Este certificado tiene una validez de 90 días a partir de la fecha de inspección, bajo el código ${codigoCertificado}. ` +
    'CERTIMOTORS garantiza la objetividad e independencia de la evaluación realizada y la trazabilidad de cada hallazgo ' +
    'registrado durante la inspección de 110 puntos. Conserve este documento como respaldo de la condición del vehículo ' +
    'al momento de la certificación.';

  doc.font('Helvetica').fontSize(10);
  const alturaTexto = doc.heightOfString(texto, { width: anchoCaja - 16 });
  doc.save().rect(xCaja, yCaja, anchoCaja, alturaTexto + 16).fillAndStroke('#F9FAFB', '#E5E7EB').restore();
  doc.fillColor('#222222').text(texto, xCaja + 8, yCaja + 8, { width: anchoCaja - 16 });
  doc.x = doc.page.margins.left;
  doc.y = yCaja + alturaTexto + 28;
  doc.fillColor('#000000').fontSize(10);
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

  dibujarSeccionGarantia(doc, { codigoCertificado });

  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1A1A1A').text('Firmas');
  doc.moveDown(3);

  const anchoTotal = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const espacio = 20;
  const anchoColumna = (anchoTotal - espacio * 2) / 3;

  const yFirma = doc.y;
  dibujarLineaFirma(doc, doc.page.margins.left, anchoColumna, 'Inspector Técnico', orden.inspector_nombre);
  doc.y = yFirma;
  dibujarLineaFirma(doc, doc.page.margins.left + anchoColumna + espacio, anchoColumna, 'Director Técnico', null);
  doc.y = yFirma;
  dibujarLineaFirma(doc, doc.page.margins.left + 2 * (anchoColumna + espacio), anchoColumna, 'Cliente / Propietario', null);

  const urlVerificacion = `https://certimotors.gt/verificar/${codigoCertificado}`;
  const qrBuffer = await QRCode.toBuffer(urlVerificacion, { width: 240, margin: 1 });
  const qrSize = 60;
  const qrX = doc.page.width - doc.page.margins.right - qrSize;
  const qrY = doc.page.height - doc.page.margins.bottom - qrSize - 30;
  doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
  doc
    .fontSize(7)
    .fillColor(COLOR.GRIS_TEXTO)
    .text('Verificar autenticidad', qrX - 40, qrY + qrSize + 2, { width: qrSize + 40, align: 'center' })
    .fillColor('#000000')
    .fontSize(10);
}

export async function generarCertificado(placa, db) {
  const orden = await db.obtenerOrdenPorPlaca(placa);
  if (!orden) {
    throw new AppError('Orden no encontrada', 404);
  }

  const revisionesRaw = await db.obtenerRevisionesPorPlaca(placa);
  const hallazgos = dedupRevisiones(revisionesRaw);

  const incluyeAdministrativo = orden.status === 'TRAMITE_COMPLETO';
  let verificaciones = [];
  if (incluyeAdministrativo) {
    const notificaciones = await db.obtenerNotificacionesPorPlacaYTipos(placa, AREAS_ADMIN);
    verificaciones = construirVerificaciones(notificaciones);
  }

  const hallazgosTexto =
    hallazgos.map((h) => `${h.punto} | ${h.estado} | ${h.nombre_punto || 'N/D'} | ${h.observacion || ''}`).join('\n') || 'Sin hallazgos registrados';
  const verificacionesTexto = incluyeAdministrativo
    ? verificaciones.map((v) => `${v.area} | ${v.estado} | ${v.detalle || ''}`).join('\n')
    : null;

  const systemPrompt = prompts.construirSystemPromptCertificado(placa, hallazgosTexto, verificacionesTexto);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const {
    veredicto,
    atencion_inmediata: atencionInmediata = [],
    observacion: observacionLista = [],
    categorias = [],
    veredicto_administrativo: veredictoAdministrativo,
  } = await llamarClaudeConTool(
    apiKey,
    db,
    systemPrompt,
    [{ role: 'user', content: `Generar certificado para placa ${placa}.` }],
    'certificado',
    placa,
    TOOL_GENERAR_CERTIFICADO
  );

  const categoriaPorPunto = new Map(categorias.map((c) => [c.punto, c.categoria]));
  const atencionPorPunto = new Map(atencionInmediata.map((a) => [a.punto, a.descripcion]));
  const observacionPorPunto = new Map(observacionLista.map((o) => [o.punto, o.descripcion]));

  const criticos = hallazgos.filter((h) => h.estado === 'MAL').length;
  const observaciones = hallazgos.filter((h) => h.estado === 'REGULAR').length;
  const aprobados = hallazgos.filter((h) => h.estado === 'BIEN').length;
  const veredictoBadge = calcularVeredicto(criticos, observaciones);
  const codigoCertificado = generarCodigoCertificado(orden);

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 50, bottom: 50, left: 50, right: 50 }, autoFirstPage: false, bufferPages: true });

  doc.addPage();
  dibujarPagina1(doc, {
    orden,
    placa,
    codigoCertificado,
    hallazgos,
    veredicto,
    veredictoBadge,
    categoriaPorPunto,
    atencionPorPunto,
    observacionPorPunto,
    criticos,
    observaciones,
    aprobados,
  });

  if (incluyeAdministrativo) {
    doc.addPage();
    dibujarPagina2(doc, { placa, codigoCertificado, verificaciones, veredictoAdministrativo });
  }

  doc.addPage();
  await dibujarPaginaFirmasYQr(doc, { placa, codigoCertificado, orden });

  const rangoPaginas = doc.bufferedPageRange();
  for (let i = rangoPaginas.start; i < rangoPaginas.start + rangoPaginas.count; i++) {
    doc.switchToPage(i);
    dibujarPiePagina(doc, placa, i - rangoPaginas.start + 1, rangoPaginas.count);
  }

  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });

  const nombreArchivo = `${placa}_${crypto.randomBytes(16).toString('hex')}.pdf`;
  let url;
  try {
    await db.asegurarBucketCertificados();
    url = await db.subirCertificado(nombreArchivo, buffer);
  } catch (error) {
    logger.warn('No se pudo subir certificado a Supabase Storage, usando fallback /tmp', { placa, error: error.message });
    const rutaLocal = path.join('/tmp', nombreArchivo);
    fs.writeFileSync(rutaLocal, buffer);
    url = rutaLocal;
  }

  await db.guardarCertificado(placa, url);
  logger.success('Certificado PDF generado', { placa, url, paginas: rangoPaginas.count });

  return { buffer, url };
}
