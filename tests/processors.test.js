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
    obtenerUltimaOrdenPorCliente: async (clienteId) => {
      const propias = Object.values(ordenes).filter((o) => o.cliente_id === clienteId);
      return propias[propias.length - 1] || null;
    },
    obtenerConversacionesPorCliente: async (clienteId) =>
      conversaciones.filter((c) => c.cliente_id === clienteId).slice(-6).reverse(),
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
  entry: [{ changes: [{ value: { messages: [{ from, type: 'text', text: { body: texto } }] } }] }],
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
  process.env.WHATSAPP_GRAPH_API_URL = url; // redirect outbound send to fake server

  const db = crearDbFake();
  await procesarWhatsapp(db, mensajeWhatsapp('Hola, quiero certificar mi placa P111AAA', { from: '50299999999' }), 'fake-key');

  assert.ok(db._clientes['50299999999']);
  assert.ok(db._ordenes.P111AAA);
  assert.equal(db._conversaciones.length, 1);
  assert.equal(db._conversaciones[0].respuesta_ia, '¡Hola! Vamos a certificar tu vehículo.');

  server.close();
  delete process.env.ANTHROPIC_API_URL;
  delete process.env.WHATSAPP_GRAPH_API_URL;
});

test('procesarWhatsapp: sin placa no crea orden, pero sí guarda la conversación pre-placa', async () => {
  const { server, url } = await crearServidorClaudeFake(() => textResponse('¿Cuál es la placa de tu vehículo?'));
  process.env.ANTHROPIC_API_URL = url;
  process.env.WHATSAPP_GRAPH_API_URL = url; // redirect outbound send to fake server

  const db = crearDbFake();
  const ordenesAntes = Object.keys(db._ordenes).length;
  await procesarWhatsapp(db, mensajeWhatsapp('Hola, tengo una pregunta', { from: '50288888888' }), 'fake-key');

  assert.ok(db._clientes['50288888888']);
  assert.equal(Object.keys(db._ordenes).length, ordenesAntes);
  assert.equal(db._conversaciones.length, 1);
  assert.equal(db._conversaciones[0].placa, null);

  server.close();
  delete process.env.ANTHROPIC_API_URL;
  delete process.env.WHATSAPP_GRAPH_API_URL;
});

test('extraerMarcadores: separa señal de servicio y escalación del texto visible', async () => {
  const { procesarWhatsapp: _, extraerMarcadores, extraerPlaca } = await import('../src/processors.js');

  const conServicio = extraerMarcadores('Perfecto, vamos con el FULL. [SERVICIO:FULL]');
  assert.equal(conServicio.servicio, 'FULL');
  assert.equal(conServicio.texto, 'Perfecto, vamos con el FULL.');
  assert.equal(conServicio.escalar, false);

  const conEscalar = extraerMarcadores('En un momento te contacta un asesor de CERTIMOTORS. [ESCALAR]');
  assert.equal(conEscalar.escalar, true);
  assert.ok(!conEscalar.texto.includes('[ESCALAR]'));

  const sinMarcadores = extraerMarcadores('¿Cuál es tu placa?');
  assert.deepEqual(sinMarcadores, { texto: '¿Cuál es tu placa?', servicio: null, escalar: false });

  // Normalización de placa: minúsculas, espacios y guiones.
  assert.equal(extraerPlaca('mi placa es p 123-abc'), 'P123ABC');
  assert.equal(extraerPlaca('P926FTB'), 'P926FTB');
  assert.equal(extraerPlaca('no tengo idea'), null);
});

const mensajeBoton = (id, title, { from = '50212345678' } = {}) => ({
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              { from, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } },
            ],
          },
        },
      ],
    },
  ],
});

test('procesarWhatsapp: botón FULL persiste servicio, pasa a ESPERANDO_PAGO y envía link de pago sin llamar a Claude', async () => {
  const enviados = [];
  const { server, url } = await crearServidorClaudeFake((body) => {
    if (body.messaging_product) {
      enviados.push(body);
      return { ok: true };
    }
    throw new Error('No debía llamar a Claude para un botón de servicio');
  });
  process.env.WHATSAPP_GRAPH_API_URL = url;
  process.env.ANTHROPIC_API_URL = 'http://127.0.0.1:1'; // si llama a Claude, truena

  const db = crearDbFake();
  db._clientes['50212345678'] = { id: 'cliente-1', numero_telefono: '50212345678' }; // dueño de P926FTB

  await procesarWhatsapp(db, mensajeBoton('servicio_FULL', 'FULL — Q1,200'), 'fake-key');

  assert.equal(db._ordenes.P926FTB.servicio, 'FULL');
  assert.equal(db._ordenes.P926FTB.status, 'ESPERANDO_PAGO');
  assert.equal(enviados.length, 1);
  // Sin RECURRENTE_SECRET_KEY el link es el placeholder.
  assert.ok(enviados[0].text.body.includes('https://pay.certimotors.com/pendiente'));

  server.close();
  delete process.env.ANTHROPIC_API_URL;
  delete process.env.WHATSAPP_GRAPH_API_URL;
});

test('procesarWhatsapp: placa y servicio en un solo mensaje — marcador [SERVICIO:FULL] elige y agrega link', async () => {
  const enviados = [];
  const { server, url } = await crearServidorClaudeFake((body) => {
    if (body.messaging_product) {
      enviados.push(body);
      return { ok: true };
    }
    return textResponse('Perfecto — ya registré tu P999ZZZ con el servicio FULL. Te paso el link de pago. [SERVICIO:FULL]');
  });
  process.env.ANTHROPIC_API_URL = url;
  process.env.WHATSAPP_GRAPH_API_URL = url;

  const db = crearDbFake();
  await procesarWhatsapp(db, mensajeWhatsapp('hola quiero certificar placa P999ZZZ con el full', { from: '50233333333' }), 'fake-key');

  assert.equal(db._ordenes.P999ZZZ.servicio, 'FULL');
  assert.equal(db._ordenes.P999ZZZ.status, 'ESPERANDO_PAGO');
  assert.equal(enviados.length, 1);
  const cuerpo = enviados[0].text.body;
  assert.ok(cuerpo.includes('Podés pagar aquí:'));
  assert.ok(!cuerpo.includes('[SERVICIO'));

  server.close();
  delete process.env.ANTHROPIC_API_URL;
  delete process.env.WHATSAPP_GRAPH_API_URL;
});

test('procesarWhatsapp: placa de otro cliente no expone la orden ajena', async () => {
  const enviados = [];
  const { server, url } = await crearServidorClaudeFake((body) => {
    if (body.messaging_product) {
      enviados.push(body);
      return { ok: true };
    }
    return textResponse('Solo puedo darte información de tus propias órdenes.');
  });
  process.env.ANTHROPIC_API_URL = url;
  process.env.WHATSAPP_GRAPH_API_URL = url;

  const db = crearDbFake();
  // P926FTB pertenece a cliente-1; escribe otro número.
  await procesarWhatsapp(db, mensajeWhatsapp('info de la placa P926FTB por favor', { from: '50244444444' }), 'fake-key');

  // No se tocó la orden ajena ni se asoció al nuevo cliente.
  assert.equal(db._ordenes.P926FTB.cliente_id, 'cliente-1');
  assert.equal(db._ordenes.P926FTB.status, 'INICIADA');
  assert.equal(enviados.length, 1);

  server.close();
  delete process.env.ANTHROPIC_API_URL;
  delete process.env.WHATSAPP_GRAPH_API_URL;
});

test('procesarPagoRecurrente: marca PAGO_CONFIRMADO y registra notificación', async () => {
  const { procesarPagoRecurrente } = await import('../src/processors.js');
  const db = crearDbFake();

  const resultado = await procesarPagoRecurrente(db, {
    event_type: 'payment_intent.succeeded',
    checkout: { metadata: { placa: 'P926FTB', servicio: 'FULL' } },
  });

  assert.equal(resultado.procesado, true);
  assert.equal(db._ordenes.P926FTB.status, 'PAGO_CONFIRMADO');
  assert.ok(db._notificaciones.some((n) => n.tipo === 'PAGO_CONFIRMADO'));
});

// ─── Bloque 3a: notificaciones de hito al cliente ────────────────────────────

const clienteConTelefono = async () => ({ id: 'cliente-1', nombre: 'Juan Pérez', numero_telefono: '50212345678' });

test('procesarTelegramMecanico: INSPECCION_COMPLETA avisa al cliente por WhatsApp', async () => {
  const enviados = [];
  const { server, url } = await crearServidorClaudeFake((body) => {
    if (body.messaging_product) {
      enviados.push(body);
      return { ok: true };
    }
    return toolUseResponse('registrar_inspeccion', {
      hallazgos: [],
      inspeccion_completa: true,
      respuesta_mecanico: 'Inspección completa.',
    });
  });
  process.env.ANTHROPIC_API_URL = url;
  process.env.WHATSAPP_GRAPH_API_URL = url;

  const db = crearDbFake({ obtenerClientePorId: clienteConTelefono });
  await procesarTelegramMecanico(db, mensajeTelegram('placa P926FTB ya terminé toda la inspección'), undefined, 'fake-key');

  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, '50212345678');
  assert.equal(enviados[0].text.body, 'Tu inspección de P926FTB está lista. Estamos preparando tu certificado.');

  server.close();
  delete process.env.ANTHROPIC_API_URL;
  delete process.env.WHATSAPP_GRAPH_API_URL;
});

test('procesarTelegramTramitador: TRAMITE_COMPLETO con FULL avisa al cliente, con BASICO no', async () => {
  for (const [servicio, esperados] of [['FULL', 1], ['BASICO', 0]]) {
    const enviados = [];
    const { server, url } = await crearServidorClaudeFake((body) => {
      if (body.messaging_product) {
        enviados.push(body);
        return { ok: true };
      }
      if (body.tools) {
        return toolUseResponse('registrar_avance_tramite', {
          actualizaciones: [],
          tramite_completo: true,
          respuesta_tramitador: 'Listo.',
        });
      }
      return textResponse('✅ APROBADO PARA CERTIFICADO');
    });
    process.env.ANTHROPIC_API_URL = url;
    process.env.WHATSAPP_GRAPH_API_URL = url;

    const db = crearDbFake({ obtenerClientePorId: clienteConTelefono });
    db._ordenes.P926FTB.servicio = servicio;
    await procesarTelegramTramitador(db, mensajeTelegram('placa P926FTB trámite terminado'), undefined, 'fake-key');

    assert.equal(enviados.length, esperados, `servicio ${servicio}: esperaba ${esperados} envío(s) WhatsApp`);
    if (esperados === 1) {
      assert.equal(
        enviados[0].text.body,
        'Las verificaciones legales de P926FTB están listas. Generando tu certificado completo.'
      );
    }

    server.close();
    delete process.env.ANTHROPIC_API_URL;
    delete process.env.WHATSAPP_GRAPH_API_URL;
  }
});

test('procesarTelegramMecanico: no re-avisa al cliente si la orden ya estaba INSPECCION_COMPLETA', async () => {
  const enviados = [];
  const { server, url } = await crearServidorClaudeFake((body) => {
    if (body.messaging_product) {
      enviados.push(body);
      return { ok: true };
    }
    return toolUseResponse('registrar_inspeccion', {
      hallazgos: [],
      inspeccion_completa: true,
      respuesta_mecanico: 'Ya estaba completa.',
    });
  });
  process.env.ANTHROPIC_API_URL = url;
  process.env.WHATSAPP_GRAPH_API_URL = url;

  const db = crearDbFake({ obtenerClientePorId: clienteConTelefono });
  db._ordenes.P926FTB.status = 'INSPECCION_COMPLETA';
  await procesarTelegramMecanico(db, mensajeTelegram('placa P926FTB ya terminé toda la inspección'), undefined, 'fake-key');

  assert.equal(enviados.length, 0);

  server.close();
  delete process.env.ANTHROPIC_API_URL;
  delete process.env.WHATSAPP_GRAPH_API_URL;
});

test('procesarPagoRecurrente: orden en ESPERANDO_PAGO (camino normal) sí procesa el pago', async () => {
  const { procesarPagoRecurrente } = await import('../src/processors.js');
  const db = crearDbFake();
  db._ordenes.P926FTB.status = 'ESPERANDO_PAGO';

  const resultado = await procesarPagoRecurrente(db, {
    event_type: 'payment_intent.succeeded',
    checkout: { metadata: { placa: 'P926FTB', servicio: 'BASICO' } },
  });

  assert.equal(resultado.procesado, true);
  assert.equal(db._ordenes.P926FTB.status, 'PAGO_CONFIRMADO');
});

test('procesarPagoRecurrente: replay del webhook no repite avisos si el pago ya se procesó', async () => {
  const { procesarPagoRecurrente } = await import('../src/processors.js');
  const db = crearDbFake();
  db._ordenes.P926FTB.status = 'PAGO_CONFIRMADO';

  const resultado = await procesarPagoRecurrente(db, {
    event_type: 'payment_intent.succeeded',
    checkout: { metadata: { placa: 'P926FTB', servicio: 'FULL' } },
  });

  assert.equal(resultado.procesado, false);
  assert.ok(!db._notificaciones.some((n) => n.tipo === 'PAGO_CONFIRMADO'));
});

test('procesarPagoRecurrente: ignora eventos que no son pago exitoso', async () => {
  const { procesarPagoRecurrente } = await import('../src/processors.js');
  const db = crearDbFake();

  const resultado = await procesarPagoRecurrente(db, {
    event_type: 'checkout.expired',
    checkout: { metadata: { placa: 'P926FTB' } },
  });

  assert.equal(resultado.procesado, false);
  assert.equal(db._ordenes.P926FTB.status, 'INICIADA');
});

// ─── Máquina de estado de conversación (WhatsApp) ─────────────────────────────

test('procesarWhatsapp: los [DATO:] del agente actualizan estado_conversacion y avanzan la etapa', async () => {
  const estadosGuardados = [];
  const { server, url } = await crearServidorClaudeFake((body) => {
    if (body.messaging_product) return { ok: true };
    return textResponse('Anotado — Corolla 2019 en Mixco. [DATO:marca=Toyota] [DATO:modelo=Corolla] [DATO:anio=2019] [DATO:zona=Mixco] [DATO:es_dueno=si]');
  });
  process.env.ANTHROPIC_API_URL = url;
  process.env.WHATSAPP_GRAPH_API_URL = url;

  try {
    const db = crearDbFake({
      actualizarEstadoConversacion: async (clienteId, estado) => estadosGuardados.push(estado),
    });
    // Cliente con estado previo: plan y contacto ya completos, en etapa vehículo/zona.
    db._clientes['50266666666'] = {
      id: 'cliente-e2e',
      numero_telefono: '50266666666',
      estado_conversacion: {
        etapa: '3_vehiculo_zona',
        persona_activa: 'sales',
        campos: {
          plan_elegido: 'BASICO', nombre: 'Ana', telefono_confirmado: '50266666666',
          placa: null, marca: null, modelo: null, anio: null, zona: null, es_dueno: null,
          fecha_tentativa: null, hora_tentativa: null,
          upsell_segunda_inspeccion: false, monto_confirmado: false,
        },
      },
    };
    await procesarWhatsapp(db, mensajeWhatsapp('es un toyota corolla 2019, está en mixco y es mío, placa P555BBB', { from: '50266666666' }), 'fake-key');

    assert.equal(estadosGuardados.length, 1);
    const estado = estadosGuardados[0];
    assert.equal(estado.campos.marca, 'Toyota');
    assert.equal(estado.campos.anio, 2019);
    assert.equal(estado.campos.zona, 'MIXCO');
    assert.equal(estado.campos.es_dueno, true);
    assert.equal(estado.campos.placa, 'P555BBB');
    assert.equal(estado.etapa, '4_agendamiento', 'con vehículo/zona completos la etapa avanza');
  } finally {
    server.close();
    delete process.env.ANTHROPIC_API_URL;
    delete process.env.WHATSAPP_GRAPH_API_URL;
  }
});

test('procesarWhatsapp: sin monto_confirmado no se crea link de pago; [SERVICIO:X] lo confirma', async () => {
  const enviados = [];
  let respuestaClaude = 'El BÁSICO cubre 110 puntos a Q550. ¿Te lo confirmo?'; // sin marcador: solo informa
  const { server, url } = await crearServidorClaudeFake((body) => {
    if (body.messaging_product) {
      enviados.push(body);
      return { ok: true };
    }
    return textResponse(respuestaClaude);
  });
  process.env.ANTHROPIC_API_URL = url;
  process.env.WHATSAPP_GRAPH_API_URL = url;

  try {
    const db = crearDbFake({ actualizarEstadoConversacion: async () => {} });
    // El número pertenece al dueño de P926FTB (cliente-1) para que la orden sea propia.
    db._clientes['50212345678'] = { id: 'cliente-1', numero_telefono: '50212345678' };
    // Turno 1: pregunta de precio — el agente NO emite [SERVICIO:X].
    await procesarWhatsapp(db, mensajeWhatsapp('cuánto cuesta el básico para mi P926FTB?', { from: '50212345678' }), 'fake-key');
    const cuerpo1 = enviados[0].interactive?.body?.text || enviados[0].text?.body;
    assert.ok(!cuerpo1.includes('Podés pagar aquí'), 'sin elección explícita no hay link de pago');
    assert.equal(db._ordenes.P926FTB.status, 'INICIADA');

    // Turno 2: elección explícita — el agente emite el marcador.
    respuestaClaude = 'Perfecto, BÁSICO para tu P926FTB. [SERVICIO:BASICO]';
    await procesarWhatsapp(db, mensajeWhatsapp('sí, dale, el básico', { from: '50212345678' }), 'fake-key');
    const cuerpo2 = enviados[1].interactive?.body?.text || enviados[1].text?.body;
    assert.ok(cuerpo2.includes('Podés pagar aquí'), 'la elección explícita confirma el monto y genera el link');
    assert.equal(db._ordenes.P926FTB.status, 'ESPERANDO_PAGO');
  } finally {
    server.close();
    delete process.env.ANTHROPIC_API_URL;
    delete process.env.WHATSAPP_GRAPH_API_URL;
  }
});

// ─── Contexto del último mensaje del bot al mecánico (incidente "No", 9 Jul) ──

test('procesarTelegramMecanico: el segundo turno recibe el último mensaje del bot como contexto', async () => {
  const systemsRecibidos = [];
  const { server, url } = await crearServidorClaudeFake((body) => {
    if (body.messaging_product) return { ok: true };
    systemsRecibidos.push(body.system?.[0]?.text || '');
    return toolUseResponse('registrar_inspeccion', {
      hallazgos: [],
      inspeccion_completa: false,
      respuesta_mecanico: '¿Confirmás que terminaste la inspección de P926FTB?',
    });
  });
  process.env.ANTHROPIC_API_URL = url;

  try {
    // "No" no trae placa: el flujo la resuelve por la última inspección activa.
    const db = crearDbFake({ obtenerUltimaPlacaPorMecanico: async () => 'P926FTB' });
    // telegram_id propio para no heredar estado del Map de otros tests
    const payload = (texto) => {
      const p = mensajeTelegram(texto);
      p.message.from.id = 777001;
      return p;
    };
    await procesarTelegramMecanico(db, payload('placa P926FTB ninguna adicional'), undefined, 'fake-key');
    await procesarTelegramMecanico(db, payload('No'), undefined, 'fake-key');

    assert.equal(systemsRecibidos.length, 2);
    assert.ok(systemsRecibidos[0].includes('(Ninguno — es el primer intercambio de esta sesión)'));
    assert.ok(
      systemsRecibidos[1].includes('¿Confirmás que terminaste la inspección de P926FTB?'),
      'el segundo turno debe llevar la pregunta de confirmación previa como contexto'
    );
  } finally {
    server.close();
    delete process.env.ANTHROPIC_API_URL;
  }
});

// ─── Comandos de bot (/start) — incidente jobs huérfanos jul 2026 ─────────────

import { esComandoBot } from '../src/processors.js';

test('esComandoBot: detecta bot_command en offset 0 y nada más', () => {
  assert.ok(esComandoBot({ entities: [{ type: 'bot_command', length: 6, offset: 0 }] }));
  assert.ok(!esComandoBot({ entities: [{ type: 'bot_command', length: 6, offset: 5 }] }));
  assert.ok(!esComandoBot({ entities: [{ type: 'mention', length: 6, offset: 0 }] }));
  assert.ok(!esComandoBot({}));
  assert.ok(!esComandoBot(undefined));
});

test('procesarTelegramMecanico: /start no entra al flujo de inspección aunque haya placa activa', async () => {
  // Escenario exacto del incidente: mecánico con inspección activa manda /start;
  // antes iba a Claude como si fuera un hallazgo. Claude apunta a un puerto
  // muerto: si se llamara, el test truena.
  const db = crearDbFake({ obtenerUltimaPlacaPorMecanico: async () => 'P926FTB' });
  const original = process.env.ANTHROPIC_API_URL;
  process.env.ANTHROPIC_API_URL = 'http://127.0.0.1:1';

  const payload = mensajeTelegram('/start');
  payload.message.entities = [{ type: 'bot_command', length: 6, offset: 0 }];
  await procesarTelegramMecanico(db, payload, undefined, 'fake-key');

  assert.equal(db._revisiones.length, 0);
  if (original) process.env.ANTHROPIC_API_URL = original;
  else delete process.env.ANTHROPIC_API_URL;
});

test('procesarTelegramTramitador: /start responde guía fija sin llamar a Claude', async () => {
  const db = crearDbFake();
  const original = process.env.ANTHROPIC_API_URL;
  process.env.ANTHROPIC_API_URL = 'http://127.0.0.1:1';

  const payload = mensajeTelegram('/start P926FTB'); // incluso con placa en el texto
  payload.message.entities = [{ type: 'bot_command', length: 6, offset: 0 }];
  await procesarTelegramTramitador(db, payload, undefined, 'fake-key');

  assert.equal(db._notificaciones.length, 0);
  if (original) process.env.ANTHROPIC_API_URL = original;
  else delete process.env.ANTHROPIC_API_URL;
});
