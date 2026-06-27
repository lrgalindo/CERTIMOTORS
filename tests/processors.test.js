import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { procesarTelegramMecanico, procesarTelegramTramitador, procesarWhatsapp } from '../src/processors.js';

// Servidor local que imita la Messages API de Anthropic: si la llamada fuerza
// un tool (tool_choice), responde con un tool_use; si no, responde texto plano.
// Permite probar el flujo completo de extracción + persistencia sin red real.
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
    usage: { input_tokens: 50, output_tokens: 20 },
  };
}

function crearDbFake(overrides = {}) {
  const revisiones = [];
  const notificaciones = [];
  const conversaciones = [];
  const clientes = {};
  const ordenes = { P926FTB: { id: 'orden-1', placa: 'P926FTB', cliente_id: 'cliente-1', tipo_auto: 'RODADO', status: 'INICIADA' } };

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
      const fila = { placa, mecanico_id, punto_actual, respuesta, created_at: new Date().toISOString() };
      revisiones.push(fila);
      return fila;
    },
    obtenerUltimaPlacaPorMecanico: async () => null,
    actualizarStatusOrden: async (placa, status) => {
      ordenes[placa] = { ...ordenes[placa], status };
    },
    actualizarDatosOrden: async (placa, datos) => {
      ordenes[placa] = { ...ordenes[placa], ...datos };
    },
    guardarCertificado: async (placa, url) => {
      ordenes[placa] = { ...ordenes[placa], certificado_url: url };
    },
    asegurarBucketCertificados: async () => {},
    subirCertificado: async () => 'https://fake-storage/certificados/fake.pdf',
    crearNotificacion: async (placa, tipo, mensaje) => {
      const fila = { placa, tipo, mensaje };
      notificaciones.push(fila);
      return fila;
    },
    obtenerNotificacionesPorPlaca: async (placa) => notificaciones.filter((n) => n.placa === placa),
    obtenerNotificacionesPorPlacaYTipos: async (placa, tipos) => notificaciones.filter((n) => n.placa === placa && tipos.includes(n.tipo)),
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

const mensajeTelegram = (texto, { chatId = 1, fromId = 100, firstName = 'Beto' } = {}) => ({
  message: { chat: { id: chatId }, from: { id: fromId, first_name: firstName }, text: texto },
});

const mensajeWhatsapp = (texto, { from = '50212345678' } = {}) => ({
  entry: [{ changes: [{ value: { messages: [{ from, text: { body: texto } }] } }] }],
});

function textResponse(texto) {
  return { content: [{ type: 'text', text: texto }], usage: { input_tokens: 30, output_tokens: 10 } };
}

test('procesarTelegramMecanico: extrae varios hallazgos de un solo mensaje', async () => {
  const { server, url } = await crearServidorClaudeFake(() =>
    toolUseResponse('registrar_inspeccion', {
      hallazgos: [
        { punto: 1, nombre_punto: 'Motor', estado: 'BIEN' },
        { punto: 2, nombre_punto: 'Frenos', estado: 'MAL', observacion: 'Pastillas gastadas' },
      ],
      inspeccion_completa: false,
      respuesta_mecanico: 'Registrado: punto 1 bien, punto 2 mal.',
    })
  );
  process.env.ANTHROPIC_API_URL = url;

  const db = crearDbFake();
  await procesarTelegramMecanico(db, mensajeTelegram('placa P926FTB motor bien, frenos mal pastillas gastadas'), undefined, 'fake-key');

  assert.equal(db._revisiones.length, 2);
  assert.equal(db._revisiones[0].punto_actual, 1);
  assert.equal(db._revisiones[1].respuesta, 'MAL - Frenos - Pastillas gastadas');

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('procesarTelegramMecanico: sin placa y sin inspección activa, no llama a Claude', async () => {
  const db = crearDbFake();
  let avisoEnviado = null;
  const enviarOriginal = process.env.ANTHROPIC_API_URL;
  process.env.ANTHROPIC_API_URL = 'http://127.0.0.1:1';

  // botToken undefined => enviarMensajeTelegram no hace red; igual confirmamos que no lanza.
  await procesarTelegramMecanico(db, mensajeTelegram('hola, cómo va todo'), undefined, 'fake-key');

  assert.equal(db._revisiones.length, 0);
  process.env.ANTHROPIC_API_URL = enviarOriginal;
  void avisoEnviado;
});

test('procesarTelegramMecanico: continúa la placa activa si no se repite en el mensaje', async () => {
  const { server, url } = await crearServidorClaudeFake(() =>
    toolUseResponse('registrar_inspeccion', {
      hallazgos: [{ punto: 3, estado: 'BIEN' }],
      respuesta_mecanico: 'ok',
    })
  );
  process.env.ANTHROPIC_API_URL = url;

  const db = crearDbFake({ obtenerUltimaPlacaPorMecanico: async () => 'P926FTB' });
  await procesarTelegramMecanico(db, mensajeTelegram('suspensión bien'), undefined, 'fake-key');

  assert.equal(db._revisiones.length, 1);
  assert.equal(db._revisiones[0].placa, 'P926FTB');

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('procesarTelegramMecanico: descarta hallazgos con punto fuera de rango', async () => {
  const { server, url } = await crearServidorClaudeFake(() =>
    toolUseResponse('registrar_inspeccion', {
      hallazgos: [
        { punto: 999, estado: 'BIEN' },
        { punto: 5, estado: 'BIEN' },
      ],
      respuesta_mecanico: 'ok',
    })
  );
  process.env.ANTHROPIC_API_URL = url;

  const db = crearDbFake();
  await procesarTelegramMecanico(db, mensajeTelegram('placa P926FTB punto 5 bien'), undefined, 'fake-key');

  assert.equal(db._revisiones.length, 1);
  assert.equal(db._revisiones[0].punto_actual, 5);

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('procesarTelegramMecanico: inspeccion_completa marca la orden y notifica', async () => {
  const { server, url } = await crearServidorClaudeFake(() =>
    toolUseResponse('registrar_inspeccion', {
      hallazgos: [],
      inspeccion_completa: true,
      respuesta_mecanico: 'Inspección completa.',
    })
  );
  process.env.ANTHROPIC_API_URL = url;

  const db = crearDbFake();
  await procesarTelegramMecanico(db, mensajeTelegram('placa P926FTB ya terminé toda la inspección'), undefined, 'fake-key');

  assert.equal(db._ordenes.P926FTB.status, 'INSPECCION_COMPLETA');
  assert.equal(db._ordenes.P926FTB.inspector_nombre, 'Beto');
  const tipos = db._notificaciones.map((n) => n.tipo);
  assert.ok(tipos.includes('INSPECCION_COMPLETA'));
  assert.ok(tipos.includes('CERTIFICADO_GENERADO'));

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('procesarTelegramTramitador: registra actualizaciones de varias áreas', async () => {
  const { server, url } = await crearServidorClaudeFake(() =>
    toolUseResponse('registrar_avance_tramite', {
      actualizaciones: [
        { area: 'IMPUESTO_CIRCULACION', estado: 'SOLVENTE' },
        { area: 'CALCOMANIA', estado: 'VENCIDA', detalle: 'Vencida desde marzo' },
      ],
      tramite_completo: false,
      respuesta_tramitador: 'Anotado.',
    })
  );
  process.env.ANTHROPIC_API_URL = url;

  const db = crearDbFake();
  await procesarTelegramTramitador(
    db,
    mensajeTelegram('placa P926FTB impuesto solvente, calcomanía vencida desde marzo'),
    undefined,
    'fake-key'
  );

  assert.equal(db._notificaciones.length, 2);
  assert.deepEqual(db._notificaciones[0], { placa: 'P926FTB', tipo: 'IMPUESTO_CIRCULACION', mensaje: 'SOLVENTE' });
  assert.deepEqual(db._notificaciones[1], { placa: 'P926FTB', tipo: 'CALCOMANIA', mensaje: 'VENCIDA: Vencida desde marzo' });

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('procesarTelegramTramitador: tramite_completo cierra la orden y dispara validación + certificado', async () => {
  const { server, url } = await crearServidorClaudeFake((body) => {
    if (body.tools) {
      return toolUseResponse('registrar_avance_tramite', {
        actualizaciones: [{ area: 'GRAVAMENES', estado: 'SIN_GRAVAMENES' }],
        tramite_completo: true,
        respuesta_tramitador: 'Listo, todo limpio.',
      });
    }
    return { content: [{ type: 'text', text: '✅ APROBADO PARA CERTIFICADO' }], usage: { input_tokens: 30, output_tokens: 10 } };
  });
  process.env.ANTHROPIC_API_URL = url;

  const db = crearDbFake();
  await procesarTelegramTramitador(db, mensajeTelegram('placa P926FTB sin gravámenes, trámite terminado'), undefined, 'fake-key');

  assert.equal(db._ordenes.P926FTB.status, 'TRAMITE_COMPLETO');
  const tipos = db._notificaciones.map((n) => n.tipo);
  assert.ok(tipos.includes('TRAMITE_COMPLETO'));
  assert.ok(tipos.includes('CERTIFICADO_VALIDACION'));
  assert.ok(tipos.includes('CERTIFICADO_GENERADO'));
  const validacion = db._notificaciones.find((n) => n.tipo === 'CERTIFICADO_VALIDACION');
  assert.equal(validacion.mensaje, '✅ APROBADO PARA CERTIFICADO');

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('procesarTelegramTramitador: descarta actualizaciones con área o estado inválido', async () => {
  const { server, url } = await crearServidorClaudeFake(() =>
    toolUseResponse('registrar_avance_tramite', {
      actualizaciones: [{ area: 'INVENTADA', estado: 'COMPLETADO' }],
      respuesta_tramitador: 'ok',
    })
  );
  process.env.ANTHROPIC_API_URL = url;

  const db = crearDbFake();
  await procesarTelegramTramitador(db, mensajeTelegram('placa P926FTB algo raro'), undefined, 'fake-key');

  assert.equal(db._notificaciones.length, 0);

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('procesarWhatsapp: cliente y placa nuevos crean cliente, orden y guardan la conversación', async () => {
  const { server, url } = await crearServidorClaudeFake(() => textResponse('¡Hola! Vamos a certificar tu vehículo.'));
  process.env.ANTHROPIC_API_URL = url;

  const db = crearDbFake();
  await procesarWhatsapp(db, mensajeWhatsapp('Hola, quiero certificar mi placa P111AAA', { from: '50299999999' }), 'fake-key');

  assert.ok(db._clientes['50299999999']);
  assert.ok(db._ordenes.P111AAA);
  assert.equal(db._conversaciones.length, 1);
  assert.equal(db._conversaciones[0].respuesta_ia, '¡Hola! Vamos a certificar tu vehículo.');

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('procesarWhatsapp: sin placa en el mensaje no crea orden ni guarda conversación', async () => {
  const { server, url } = await crearServidorClaudeFake(() => textResponse('¿Cuál es la placa de tu vehículo?'));
  process.env.ANTHROPIC_API_URL = url;

  const db = crearDbFake();
  const ordenesAntes = Object.keys(db._ordenes).length;
  await procesarWhatsapp(db, mensajeWhatsapp('Hola, tengo una pregunta', { from: '50288888888' }), 'fake-key');

  assert.ok(db._clientes['50288888888']);
  assert.equal(Object.keys(db._ordenes).length, ordenesAntes);
  assert.equal(db._conversaciones.length, 0);

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});
