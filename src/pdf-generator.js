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
  GRIS_BADGE: '#4b5563',
};

// Fuente pública de cada verificación legal — línea de fuente en los bloques
// de la página 2 (transparencia de dónde sale el dato, patrón informe v2).
const FUENTE_AREA = {
  IMPUESTO_CIRCULACION: 'Fuente: SAT — estado de cuenta del impuesto de circulación',
  CALCOMANIA: 'Fuente: SAT — calcomanía electrónica de circulación',
  MULTAS: 'Fuente: registros municipales de tránsito (Emetra/PMT)',
  GRAVAMENES: 'Fuente: Registro de Garantías Mobiliarias',
};

// Qué significa un impedimento para el comprador, en lenguaje claro.
const IMPACTO_AREA = {
  IMPUESTO_CIRCULACION: 'Hay impuesto pendiente: el traspaso no procede hasta ponerse al día, y la deuda pasa con el vehículo — negociá que el vendedor la salde antes de pagar.',
  CALCOMANIA: 'La calcomanía está vencida: el vehículo puede ser multado al circular y hay que renovarla antes o inmediatamente después del traspaso.',
  MULTAS: 'Hay multas registradas: quedan asociadas al vehículo — pedí que el vendedor las pague antes de cerrar el trato.',
  GRAVAMENES: 'Hay un gravamen activo: el vehículo está dado en garantía de una deuda y un tercero podría reclamarlo. No comprés sin que se libere el gravamen primero.',
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

// Fila de pills con lo que incluye el servicio contratado, debajo del encabezado.
function dibujarBadgesServicio(doc, orden) {
  const incluye = ['INSPECCIÓN 110 PUNTOS', 'CERTIFICADO CON QR'];
  if (orden.servicio === 'FULL') incluye.push('VERIFICACIÓN LEGAL SAT/MUNI');

  const y = doc.y;
  let x = doc.page.margins.left;
  doc.font('Helvetica-Bold').fontSize(7.5);
  for (const texto of incluye) {
    const width = doc.widthOfString(texto) + 14;
    doc.save().roundedRect(x, y, width, 16, 8).fill(COLOR.GRIS_BADGE).restore();
    doc.fillColor('#FFFFFF').text(texto, x + 7, y + 4.5);
    x += width + 8;
  }
  doc.fillColor('#000000').font('Helvetica').fontSize(10);
  doc.x = doc.page.margins.left;
  doc.y = y + 26;
}

// Hasta 6 fotos del mecánico en grilla de 3 columnas, caption corto debajo
// (nombre del hallazgo, no descripción). fotos: [{ buffer, caption }].
function dibujarFotos(doc, fotos) {
  if (!fotos.length) return;

  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1A1A1A').text('Registro fotográfico de la inspección');
  doc.moveDown(0.3);

  const espacio = 10;
  const anchoUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const anchoFoto = (anchoUtil - espacio * 2) / 3;
  const altoFoto = 95;
  const altoCelda = altoFoto + 16;

  fotos.slice(0, 6).forEach((foto, i) => {
    const col = i % 3;
    if (col === 0) {
      // Salto de página manual si la fila no cabe completa.
      if (doc.y + altoCelda > doc.page.height - doc.page.margins.bottom) doc.addPage();
      doc._filaFotosY = doc.y;
    }
    const x = doc.page.margins.left + col * (anchoFoto + espacio);
    const y = doc._filaFotosY;
    try {
      doc.image(foto.buffer, x, y, { fit: [anchoFoto, altoFoto], align: 'center', valign: 'center' });
    } catch {
      doc.save().rect(x, y, anchoFoto, altoFoto).fill('#EEEEEE').restore();
    }
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(COLOR.GRIS_TEXTO)
      .text((foto.caption || 'Hallazgo').slice(0, 60), x, y + altoFoto + 3, { width: anchoFoto, height: 12, ellipsis: true });
    if (col === 2 || i === Math.min(fotos.length, 6) - 1) {
      doc.x = doc.page.margins.left;
      doc.y = y + altoCelda + 6;
    }
  });
  doc.fillColor('#000000').font('Helvetica').fontSize(10);
  doc.moveDown(0.4);
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
  dibujarBadgesServicio(doc, datos.orden);
  dibujarTablaVehiculo(doc, datos);
  dibujarVeredicto(doc, datos);
  dibujarResumenBoxes(doc, datos);
  dibujarTablaHallazgos(doc, datos);
  dibujarFotos(doc, datos.fotos || []);
}

// Bloque modular por verificación legal: badge de estado, explicación en
// lenguaje claro, línea de fuente y callout de impacto si hay impedimento.
function dibujarBloqueVerificacion(doc, v) {
  const limpio = ESTADOS_LIMPIOS.includes(v.estado);
  const noVerificado = v.estado === 'NO_VERIFICADO';
  const badge = noVerificado
    ? { texto: 'NO VERIFICADO', color: COLOR.GRIS_BADGE }
    : limpio
      ? { texto: 'OK', color: COLOR.BIEN }
      : { texto: 'PRECAUCIÓN', color: COLOR.REGULAR };

  const x = doc.page.margins.left;
  const anchoUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const explicacion = [
    `${ESTADO_LABELS[v.estado] || v.estado}${v.detalle ? ` — ${v.detalle}` : '.'}`,
  ].join(' ');
  const impacto = !limpio && !noVerificado ? IMPACTO_AREA[v.area] : null;

  // Altura estimada del bloque para no partirlo entre páginas.
  doc.font('Helvetica').fontSize(9.5);
  let alto = 26 + doc.heightOfString(explicacion, { width: anchoUtil - 24 }) + 14;
  if (impacto) alto += doc.heightOfString(impacto, { width: anchoUtil - 40 }) + 18;
  if (doc.y + alto > doc.page.height - doc.page.margins.bottom) doc.addPage();

  const yInicio = doc.y;
  doc.save().rect(x, yInicio, anchoUtil, alto).fillAndStroke('#FBFBFC', '#E5E7EB').restore();
  doc.save().rect(x, yInicio, 4, alto).fill(badge.color).restore();

  doc.fillColor('#1A1A1A').font('Helvetica-Bold').fontSize(11).text(AREA_LABELS[v.area], x + 12, yInicio + 8);
  dibujarBadge(doc, x + anchoUtil - 110, yInicio + 6, badge.texto, badge.color, { fontSize: 8, paddingX: 8, paddingY: 3 });

  doc.fillColor('#333333').font('Helvetica').fontSize(9.5).text(explicacion, x + 12, yInicio + 26, { width: anchoUtil - 24 });
  doc.fillColor(COLOR.GRIS_TEXTO).fontSize(7.5).text(FUENTE_AREA[v.area] || '', x + 12, doc.y + 2, { width: anchoUtil - 24 });

  if (impacto) {
    doc
      .fillColor('#7c2d12')
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .text('Qué significa esto para vos: ', x + 24, doc.y + 6, { width: anchoUtil - 40, continued: true })
      .font('Helvetica')
      .text(impacto);
  }

  doc.fillColor('#000000').font('Helvetica').fontSize(10);
  doc.x = doc.page.margins.left;
  doc.y = yInicio + alto + 10;
}

function dibujarPagina2(doc, { placa, codigoCertificado, verificaciones, veredictoAdministrativo }) {
  dibujarEncabezadoPrincipal(doc, { placa, codigoCertificado });

  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1A1A1A').text('Parte 2 — Verificación legal y administrativa');
  doc.moveDown(0.4);

  const todasLimpias = verificaciones.every((v) => ESTADOS_LIMPIOS.includes(v.estado));
  const badgeAdmin = todasLimpias ? { texto: 'APTO PARA TRASPASO', color: COLOR.BIEN } : { texto: 'CON IMPEDIMENTOS', color: COLOR.MAL };
  dibujarBadge(doc, doc.page.margins.left, doc.y, badgeAdmin.texto, badgeAdmin.color, { fontSize: 11, paddingX: 12, paddingY: 6 });
  doc.moveDown(0.8);

  for (const v of verificaciones) {
    dibujarBloqueVerificacion(doc, v);
  }

  doc.moveDown(0.4);
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

// Checklist completo de los puntos reportados, por categoría, como respaldo
// visible de la inspección (complementa el veredicto sintetizado de la pág. 1).
// Marcas: ✓ verde (BIEN, ZapfDingbats), ! naranja (REGULAR), ✗ rojo (MAL).
function dibujarChecklistCompleto(doc, { hallazgos, categoriaPorPunto }) {
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1A1A1A').text('Checklist de la inspección');
  doc.moveDown(0.2);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(COLOR.GRIS_TEXTO)
    .text(`Detalle punto por punto de los ${hallazgos.length} puntos reportados por el inspector, agrupados por sistema.`);
  doc.moveDown(0.5);

  const porCategoria = new Map();
  for (const h of hallazgos) {
    const categoria = categoriaPorPunto.get(h.punto) || 'OTROS';
    if (!porCategoria.has(categoria)) porCategoria.set(categoria, []);
    porCategoria.get(categoria).push(h);
  }

  const anchoUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Marcas vectoriales: los glifos ✓/✗ no existen en las fuentes base de
  // pdfkit (WinAnsi) y ZapfDingbats mapea a otros símbolos — se dibujan a mano.
  const dibujarMarca = (estado, x, y) => {
    doc.save().lineWidth(1.4);
    if (estado === 'BIEN') {
      doc.moveTo(x, y + 4).lineTo(x + 2.5, y + 6.5).lineTo(x + 7, y + 0.5).stroke(COLOR.BIEN);
    } else if (estado === 'MAL') {
      doc.moveTo(x, y + 1).lineTo(x + 6, y + 7).moveTo(x + 6, y + 1).lineTo(x, y + 7).stroke(COLOR.MAL);
    } else {
      doc.restore();
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.REGULAR).text('!', x + 2, y - 1.5, { lineBreak: false });
      return;
    }
    doc.restore();
  };

  for (const categoria of [...Object.keys(CATEGORIA_LABELS), 'OTROS']) {
    const items = porCategoria.get(categoria);
    if (!items?.length) continue;

    if (doc.y + 30 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.save().rect(doc.page.margins.left, doc.y, anchoUtil, 16).fill(COLOR.GRIS_HEADER).restore();
    doc.fillColor('#1A1A1A').font('Helvetica-Bold').fontSize(9).text(CATEGORIA_LABELS[categoria] || 'Otros', doc.page.margins.left + 4, doc.y + 4);
    doc.y += 8;

    for (const h of items) {
      if (doc.y + 12 > doc.page.height - doc.page.margins.bottom) doc.addPage();
      const y = doc.y;
      dibujarMarca(h.estado, doc.page.margins.left + 6, y);
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor('#333333')
        .text(`${h.punto} · ${h.nombre_punto || 'N/D'}${h.observacion ? ` — ${h.observacion}` : ''}`, doc.page.margins.left + 22, y, {
          width: anchoUtil - 22,
          height: 10,
          ellipsis: true,
        });
      doc.x = doc.page.margins.left;
      doc.y = y + 11;
    }
    doc.moveDown(0.4);
  }
  doc.fillColor('#000000').font('Helvetica').fontSize(10);
  doc.moveDown(0.4);
}

// El VIN/chasis/motor impresos deben compararse contra el vehículo físico:
// es la defensa del comprador contra un certificado usado en otro carro.
function dibujarCajaVerificacionFisica(doc, { orden, placa }) {
  const xCaja = doc.page.margins.left;
  const anchoCaja = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const texto =
    `Antes de cerrar la compra, compará estos datos contra el vehículo físico: placa ${placa}, ` +
    `chasis/VIN ${orden.chasis || 'no registrado'}, motor ${orden.motor || 'no registrado'}. ` +
    'Si algún número no coincide con el que ves en el carro, este certificado no aplica a ese vehículo.';

  doc.font('Helvetica').fontSize(9);
  const alturaTexto = doc.heightOfString(texto, { width: anchoCaja - 16 }) + 16;
  if (doc.y + alturaTexto + 20 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  const yCaja = doc.y;
  doc.save().rect(xCaja, yCaja, anchoCaja, alturaTexto + 14).fillAndStroke('#fffbeb', '#f59e0b').restore();
  doc.fillColor('#78350f').font('Helvetica-Bold').fontSize(9).text('VERIFICÁ FÍSICAMENTE', xCaja + 8, yCaja + 7);
  doc.font('Helvetica').text(texto, xCaja + 8, yCaja + 20, { width: anchoCaja - 16 });
  doc.fillColor('#000000').fontSize(10);
  doc.x = doc.page.margins.left;
  doc.y = yCaja + alturaTexto + 24;
}

function dibujarSeccionGarantia(doc, { codigoCertificado, orden }) {
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1A1A1A').text('Garantía y vigencia');
  doc.moveDown(0.3);

  const fechaInspeccion = new Date(orden?.updated_at || orden?.created_at || Date.now());
  const vence = new Date(fechaInspeccion.getTime() + 90 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toLocaleDateString('es-GT', { dateStyle: 'long', timeZone: 'America/Guatemala' });

  const xCaja = doc.page.margins.left;
  const anchoCaja = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const yCaja = doc.y;
  const texto =
    `Certificado ${codigoCertificado} — vigente por 90 días: del ${fmt(fechaInspeccion)} al ${fmt(vence)}. ` +
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

async function dibujarPaginaFirmasYQr(doc, { placa, codigoCertificado, orden, hallazgos, categoriaPorPunto }) {
  dibujarEncabezadoPrincipal(doc, { placa, codigoCertificado });

  dibujarChecklistCompleto(doc, { hallazgos, categoriaPorPunto });

  dibujarSeccionGarantia(doc, { codigoCertificado, orden });

  dibujarCajaVerificacionFisica(doc, { orden, placa });

  // Firmas y QR van juntos al pie: si no queda espacio, página nueva.
  if (doc.y + 160 > doc.page.height - doc.page.margins.bottom) doc.addPage();
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

  // Fotos del mecánico (best-effort): las más relevantes primero — hallazgos
  // MAL, luego REGULAR, luego el resto. Si la tabla/bucket no existen todavía
  // (migración 008 pendiente) o una descarga falla, el PDF sale sin fotos.
  let fotos = [];
  try {
    if (typeof db.obtenerFotosPorPlaca === 'function' && typeof db.descargarFoto === 'function') {
      const estadoPorPunto = new Map(hallazgos.map((h) => [h.punto, h.estado]));
      const rango = { MAL: 0, REGULAR: 1 };
      const filas = (await db.obtenerFotosPorPlaca(placa))
        .sort((a, b) => (rango[estadoPorPunto.get(a.punto)] ?? 2) - (rango[estadoPorPunto.get(b.punto)] ?? 2))
        .slice(0, 6);
      fotos = (
        await Promise.all(
          filas.map(async (f) => {
            try {
              return { buffer: await db.descargarFoto(f.storage_path), caption: f.caption };
            } catch {
              return null;
            }
          })
        )
      ).filter(Boolean);
    }
  } catch (error) {
    logger.warn('No se pudieron cargar fotos de inspección para el PDF', { placa, error: error.message });
  }

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
    fotos,
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
  await dibujarPaginaFirmasYQr(doc, { placa, codigoCertificado, orden, hallazgos, categoriaPorPunto });

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
