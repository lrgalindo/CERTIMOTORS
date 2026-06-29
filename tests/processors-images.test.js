import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { procesarTelegramMecanico, procesarTelegramTramitador, procesarWhatsapp } from '../src/processors.js';

// Servidor local que imita Anthropic Claude API para estos tests de imágenes.
function crearServidorClaudeFake(responderFn) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const respuesta = responderFn(parsed);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(respuesta));
      });
    });
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function toolUseResponse(toolName, input) {
  return {
    content: [{ type: 'tool_use', name: toolName, input }],
    usage: { input_tokens: 30, output_tokens: 20 },
  };
}

function textResponse(texto) {
  return { content: [{ type: 'text', text: texto }], usage: { input_tokens: 20, output_tokens: 10 } };
}

function crearDbFake(overrides = {}) {
  const revisiones = [];
  const notificaciones = [];
  const conversaciones = [];
  const clientes = {};
  const ordenes = {
    P926FTB: { id: 'orden-1', placa: 'P926FTB', cliente_id: 'cliente-1', tipo_auto: 'RODADO', status: 'INICIADA' },
  };

  return {
    obtenerGastoDesde: async () => [],
    registrarCostoAPI: async () => {},
    obtenerOrdenPorPlaca: async (placa) => ordenes[placa] || null,
    crearOrden: async (placa, data = {}) => {
      const orden = { id: `orden-${placa}`, placa, status: 'INICIADA', ...data };
      ordenes[placa] = orden;
      return orden;
    },
    obtenerRevisionesPorPlaca: async (placa) => revisiones.filter((r) => r.placa === placa),
    guardarRevision: async (placa, mecanico_id, punto_actual, respuesta) => {
      const fila = { placa, mecanico_id, punto_actual, respuesta };
      revisiones.push(fila);
      return fila;
    },
    obtenerUltimaPlacaPorMecanico: async () => null,
    actualizarStatusOrden: async (placa, status) => {
      ordenes[placa] = { ...ordenes[placa], status };
    },
    crearNotificacion: async (placa, tipo, mensaje) => {
      const fila = { placa, tipo, mensaje };
      notificaciones.push(fila);
      return fila;
    },
    obtenerNotificacionesPorPlaca: async (placa) => notificaciones.filter((n) => n.placa === placa),
    obtenerClientePorId: async () => ({ nombre: 'Juan Pérez' }),
    obtenerClientePorNumero: async (numero) => clientes[numero] || null,
    crearCliente: async (numero, data = {}) => {
      const cliente = { id: `cliente-${numero}`, numero_telefono: numero, ...data };
      clientes[numero] = cliente;
      return cliente;
    },
    obtenerConversacionesPorPlaca: async (placa) => conversaciones.filter((c) => c.placa === placa),
    guardarConversacion: async (placa, cliente_id, tipo_usuario, mensaje_entrada, respuesta_ia) => {
      const fila = { placa, cliente_id, tipo_usuario, mensaje_entrada, respuesta_ia };
      conversaciones.push(fila);
      return fila;
    },
    _revisiones: revisiones,
    _notificaciones: notificaciones,
    _conversaciones: conversaciones,
    _ordenes: ordenes,
    _clientes: clientes,
    ...overrides,
  };
}

// Payloads de Telegram con photo[] (sin campo text)
const fotoTelegram = ({ chatId = 1, fromId = 100, firstName = 'Beto', caption = '' } = {}) => ({
  message: {
    chat: { id: chatId },
    from: { id: fromId, first_name: firstName },
    photo: [
      { file_id: 'AAA', width: 320, height: 240 },
      { file_id: 'BBB', width: 800, height: 600 },
    ],
    ...(caption ? { caption } : {}),
  },
});

// Payload de WhatsApp con message.image (sin campo text)
const imagenWhatsapp = (mediaId = 'media-id-123', { from = '50212345678' } = {}) => ({
  entry: [
    {
      changes: [
        {
          value: {
            messages: [{ from, type: 'image', image: { id: mediaId, mime_type: 'image/jpeg' } }],
          },
        },
      ],
    },
  ],
});

// ─── Telegram photo[] ──────────────────────────────────────────────────────────

test('procesarTelegramMecanico: mensaje con photo[] sin caption no lanza excepción', async () => {
  // sin placa en el payload → pregunta por la placa y retorna limpiamente
  const db = crearDbFake();
  await assert.doesNotReject(() =>
    procesarTelegramMecanico(db, fotoTelegram(), undefined, 'fake-key')
  );
  assert.equal(db._revisiones.length, 0);
});

test('procesarTelegramMecanico: photo[] con caption que incluye placa registra hallazgos', async () => {
  const { server, url } = await crearServidorClaudeFake(() =>
    toolUseResponse('registrar_inspeccion', {
      hallazgos: [{ punto: 5, nombre_punto: 'Carrocería', estado: 'REGULAR' }],
      inspeccion_completa: false,
      respuesta_mecanico: 'Foto recibida, punto 5 registrado.',
    })
  );
  process.env.ANTHROPIC_API_URL = url;

  const db = crearDbFake();
  await procesarTelegramMecanico(
    db,
    fotoTelegram({ caption: 'placa P926FTB carrocería regular' }),
    undefined,
    'fake-key'
  );

  assert.equal(db._revisiones.length, 1);
  assert.equal(db._revisiones[0].punto_actual, 5);

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('procesarTelegramMecanico: degradación graceful si falla descarga de imagen (botToken = undefined)', async () => {
  const { server, url } = await crearServidorClaudeFake(() =>
    toolUseResponse('registrar_inspeccion', {
      hallazgos: [{ punto: 10, nombre_punto: 'Vidrios', estado: 'BIEN' }],
      inspeccion_completa: false,
      respuesta_mecanico: 'ok',
    })
  );
  process.env.ANTHROPIC_API_URL = url;

  // botToken = undefined → obtenerImagenTelegram retorna null inmediatamente (degradación graceful)
  const db = crearDbFake();
  await assert.doesNotReject(() =>
    procesarTelegramMecanico(
      db,
      fotoTelegram({ caption: 'placa P926FTB vidrios bien' }),
      undefined,
      'fake-key'
    )
  );
  // El hallazgo igual se registra gracias a Claude
  assert.equal(db._revisiones.length, 1);

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('procesarTelegramTramitador: photo[] con caption que incluye placa se procesa sin error', async () => {
  const { server, url } = await crearServidorClaudeFake(() =>
    toolUseResponse('registrar_avance_tramite', {
      actualizaciones: [{ area: 'DOCUMENTOS', estado: 'COMPLETADO' }],
      tramite_completo: false,
      respuesta_tramitador: 'Foto recibida, documentos anotados.',
    })
  );
  process.env.ANTHROPIC_API_URL = url;

  const db = crearDbFake();
  await assert.doesNotReject(() =>
    procesarTelegramTramitador(
      db,
      fotoTelegram({ caption: 'placa P926FTB documentos completos' }),
      undefined,
      'fake-key'
    )
  );
  assert.equal(db._notificaciones.length, 1);
  assert.equal(db._notificaciones[0].tipo, 'DOCUMENTOS');

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

// ─── WhatsApp image ────────────────────────────────────────────────────────────

test('procesarWhatsapp: mensaje con image (sin text) crea cliente y llama a Claude', async () => {
  const { server, url } = await crearServidorClaudeFake(() =>
    textResponse('Recibí tu imagen. ¿Cuál es la placa de tu vehículo?')
  );
  process.env.ANTHROPIC_API_URL = url;

  const db = crearDbFake();
  await assert.doesNotReject(() =>
    procesarWhatsapp(db, imagenWhatsapp('media-id-abc', { from: '50277777777' }), 'fake-key')
  );
  // Cliente creado aunque no haya placa
  assert.ok(db._clientes['50277777777'], 'cliente debe existir');
  // Sin placa en el mensaje → no se crea orden
  assert.equal(Object.keys(db._ordenes).length, 1, 'no debe crearse orden nueva');

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('procesarWhatsapp: mensaje sin text ni image retorna sin procesar', async () => {
  const payloadVacio = {
    entry: [{ changes: [{ value: { messages: [{ from: '50212345678', type: 'sticker' }] } }] }],
  };

  const db = crearDbFake();
  await assert.doesNotReject(() => procesarWhatsapp(db, payloadVacio, 'fake-key'));
  assert.equal(Object.keys(db._clientes).length, 0, 'no debe crear cliente para tipo sin soporte');
});
