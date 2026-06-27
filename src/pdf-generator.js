import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
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

const CATEGORIA_LABELS = {
  MOTOR_TRANSMISION: '1. Motor y transmisión',
  FRENOS_SUSPENSION: '2. Frenos y suspensión',
  DIRECCION_NEUMATICOS: '3. Dirección y neumáticos',
  SISTEMA_ELECTRICO: '4. Sistema eléctrico',
  CARROCERIA_EXTERIOR: '5. Carrocería exterior',
  INTERIOR_TAPICERIA: '6. Interior y tapicería',
  DOCUMENTACION_ACCESORIOS: '7. Documentación y accesorios',
  FLUIDOS_FILTROS: '8. Fluidos y filtros',
};

const COLOR_ESTADO = { BIEN: '#2E7D32', REGULAR: '#E08E0B', MAL: '#C62828' };

function formatearFechaHora(fecha = new Date()) {
  return fecha.toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Guatemala' });
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

function dibujarPiePagina(doc, placa) {
  const { x: x0, y: y0 } = doc;
  const bottomMarginOriginal = doc.page.margins.bottom;
  const bottom = doc.page.height - bottomMarginOriginal + 14;

  // El texto del pie cae dentro del margen inferior reservado; sin anular el
  // margen aquí, pdfkit interpreta que no cabe y dispara un salto de página
  // automático dentro del propio handler de 'pageAdded' (recursión infinita).
  doc.page.margins.bottom = 0;
  doc
    .fontSize(8)
    .fillColor('#888888')
    .text(`Certificado generado por CERTIMOTORS — Guatemala  ·  Orden ${placa}  ·  ${formatearFechaHora()}`, doc.page.margins.left, bottom, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: 'center',
    })
    .fillColor('#000000');
  doc.page.margins.bottom = bottomMarginOriginal;

  doc.x = x0;
  doc.y = y0;
}

function dibujarEncabezado(doc, titulo) {
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#1A1A1A').text('CERTIMOTORS');
  doc.fontSize(12).font('Helvetica').fillColor('#444444').text(titulo);
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#CCCCCC').stroke();
  doc.moveDown(0.8);
  doc.fillColor('#000000');
}

function dibujarSeccionTitulo(doc, texto) {
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1A1A1A').text(texto);
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor('#000000');
}

function dibujarBullet(doc, color, texto) {
  const xBullet = doc.x;
  const yBullet = doc.y + 4;
  doc.save().fillColor(color).circle(xBullet + 3, yBullet, 3).fill().restore();
  doc.fillColor('#222222').fontSize(10).text(texto, xBullet + 14, doc.y, {
    width: doc.page.width - doc.page.margins.right - (xBullet + 14),
  });
  doc.moveDown(0.25);
  doc.fillColor('#000000');
}

function dibujarPagina1(doc, { orden, placa, hallazgos, veredicto, atencionPorPunto, observacionPorPunto }) {
  dibujarEncabezado(doc, 'Certificado de Inspección Vehicular');

  doc.fontSize(10).font('Helvetica');
  const datos = [
    [`Placa: ${placa}`, `Marca/Modelo: ${[orden.marca, orden.modelo].filter(Boolean).join(' ') || 'No disponible'}`],
    [`Año: ${orden.anio || 'No disponible'}`, `Kilometraje: ${orden.kilometraje ? `${orden.kilometraje} km` : 'No disponible'}`],
    [`Fecha inspección: ${formatearFechaHora(new Date(orden.updated_at || orden.created_at))}`, `Inspector: ${orden.inspector_nombre || 'No disponible'}`],
  ];
  for (const [izq, der] of datos) {
    const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 2;
    const y = doc.y;
    doc.text(izq, doc.page.margins.left, y, { width: colWidth });
    doc.text(der, doc.page.margins.left + colWidth, y, { width: colWidth });
    doc.moveDown(0.2);
  }
  doc.moveDown(0.6);

  dibujarSeccionTitulo(doc, 'Veredicto general');
  doc.fontSize(10).fillColor('#222222').text(veredicto || 'Sin información suficiente para emitir un veredicto.', {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
  });
  doc.moveDown(0.8);

  const malos = hallazgos.filter((h) => h.estado === 'MAL');
  dibujarSeccionTitulo(doc, `Atención inmediata (${malos.length})`);
  if (malos.length === 0) {
    doc.fillColor('#555555').text('Ningún punto crítico detectado.');
  } else {
    for (const h of malos) {
      dibujarBullet(doc, COLOR_ESTADO.MAL, atencionPorPunto.get(h.punto) || [h.nombre_punto, h.observacion].filter(Boolean).join(' — '));
    }
  }
  doc.moveDown(0.6);

  const regulares = hallazgos.filter((h) => h.estado === 'REGULAR');
  dibujarSeccionTitulo(doc, `Mantener bajo observación (${regulares.length})`);
  if (regulares.length === 0) {
    doc.fillColor('#555555').text('Ningún punto en observación.');
  } else {
    for (const h of regulares) {
      dibujarBullet(doc, COLOR_ESTADO.REGULAR, observacionPorPunto.get(h.punto) || [h.nombre_punto, h.observacion].filter(Boolean).join(' — '));
    }
  }
  doc.moveDown(0.6);

  const buenos = hallazgos.filter((h) => h.estado === 'BIEN').length;
  dibujarSeccionTitulo(doc, `Puntos en buen estado: ${buenos}/${TOTAL_PUNTOS}`);
}

function dibujarPagina2(doc, { hallazgos, categoriaPorPunto }) {
  dibujarEncabezado(doc, 'Detalle técnico completo');

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

    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1A1A1A').text(CATEGORIA_LABELS[categoria] || 'Otros hallazgos');
    doc.moveDown(0.2);

    doc.table({
      data: [
        ['Punto', 'Estado', 'Detalle'],
        ...items.map((h) => [
          String(h.punto),
          { text: h.estado, textColor: COLOR_ESTADO[h.estado] || '#000000' },
          [h.nombre_punto, h.observacion].filter(Boolean).join(' — ') || 'Sin detalle',
        ]),
      ],
      rowStyles: (i) => (i === 0 ? { font: { family: 'Helvetica-Bold' }, backgroundColor: '#EEEEEE' } : {}),
      columnStyles: [{ width: 45 }, { width: 65 }, { width: '*' }],
      padding: 4,
    });
    doc.moveDown(0.6);
    doc.fontSize(10).font('Helvetica').fillColor('#000000');
  }
}

function dibujarPagina3(doc, { verificaciones, veredictoAdministrativo }) {
  dibujarEncabezado(doc, 'Verificación administrativa');

  doc.table({
    data: [
      ['Verificación', 'Estado', 'Detalle'],
      ...verificaciones.map((v) => [
        AREA_LABELS[v.area],
        { text: v.estado, textColor: ESTADOS_LIMPIOS.includes(v.estado) ? COLOR_ESTADO.BIEN : v.estado === 'NO_VERIFICADO' ? '#888888' : COLOR_ESTADO.MAL },
        v.detalle || '—',
      ]),
    ],
    rowStyles: (i) => (i === 0 ? { font: { family: 'Helvetica-Bold' }, backgroundColor: '#EEEEEE' } : {}),
    columnStyles: [{ width: 150 }, { width: 90 }, { width: '*' }],
    padding: 5,
  });

  doc.moveDown(0.8);
  dibujarSeccionTitulo(doc, 'Veredicto administrativo');
  doc.fontSize(10).fillColor('#222222').text(veredictoAdministrativo || 'Sin información suficiente para emitir un veredicto administrativo.');
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

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 50, bottom: 50, left: 50, right: 50 }, autoFirstPage: false });
  doc.on('pageAdded', () => dibujarPiePagina(doc, placa));

  doc.addPage();
  dibujarPagina1(doc, { orden, placa, hallazgos, veredicto, atencionPorPunto, observacionPorPunto });

  doc.addPage();
  dibujarPagina2(doc, { hallazgos, categoriaPorPunto });

  if (incluyeAdministrativo) {
    doc.addPage();
    dibujarPagina3(doc, { verificaciones, veredictoAdministrativo });
  }

  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });

  const nombreArchivo = `${placa}_${Date.now()}.pdf`;
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
  logger.success('Certificado PDF generado', { placa, url, paginas: incluyeAdministrativo ? 3 : 2 });

  return { buffer, url };
}
