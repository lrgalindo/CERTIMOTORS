import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { llamarClaudeAPI, llamarClaudeConTool } from '../src/claude-client.js';
import { BUDGET_LIMIT_USD } from '../src/budget-tracker.js';

function crearServidorClaudeFake(responderFn) {
  return new Promise((resolve) => {
    const recibidos = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        recibidos.push(parsed);
        const respuesta = responderFn(parsed);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(respuesta));
      });
    });
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, recibidos });
    });
  });
}

const dbFakeBajoPresupuesto = { obtenerGastoDesde: async () => [], registrarCostoAPI: async () => {} };

test('llamarClaudeAPI: devuelve el texto del primer bloque de contenido', async () => {
  const { server, url } = await crearServidorClaudeFake(() => ({
    content: [{ type: 'text', text: 'Hola, ¿en qué puedo ayudarte?' }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
  process.env.ANTHROPIC_API_URL = url;

  const texto = await llamarClaudeAPI('fake-key', dbFakeBajoPresupuesto, 'system', [{ role: 'user', content: 'hola' }], 'cliente');
  assert.equal(texto, 'Hola, ¿en qué puedo ayudarte?');

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('llamarClaudeAPI: presupuesto agotado bloquea sin llamar a la red', async () => {
  process.env.ANTHROPIC_API_URL = 'http://127.0.0.1:1';
  const dbBloqueado = { obtenerGastoDesde: async () => [{ costo_estimado_usd: String(BUDGET_LIMIT_USD) }] };

  await assert.rejects(
    () => llamarClaudeAPI('fake-key', dbBloqueado, 'system', [{ role: 'user', content: 'hola' }], 'cliente'),
    (err) => err.statusCode === 402
  );

  delete process.env.ANTHROPIC_API_URL;
});

test('llamarClaudeAPI: degrada el modelo cuando el gasto supera el 80%', async () => {
  const { server, url, recibidos } = await crearServidorClaudeFake(() => ({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
  process.env.ANTHROPIC_API_URL = url;

  const gastoDegradado = BUDGET_LIMIT_USD * 0.85;
  const dbDegradado = {
    obtenerGastoDesde: async () => [{ costo_estimado_usd: String(gastoDegradado) }],
    registrarCostoAPI: async () => {},
  };

  // rol 'validator' usa Opus por default; en nivel degradado debe bajar a Sonnet.
  await llamarClaudeAPI('fake-key', dbDegradado, 'system', [{ role: 'user', content: 'hola' }], 'validator');

  assert.equal(recibidos[0].model, 'claude-sonnet-4-6');

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('llamarClaudeConTool: fuerza tool_choice y devuelve el input parseado', async () => {
  const tool = { name: 'mi_tool', description: 'test', input_schema: { type: 'object', properties: {} } };
  const { server, url, recibidos } = await crearServidorClaudeFake(() => ({
    content: [{ type: 'tool_use', name: 'mi_tool', input: { foo: 'bar' } }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
  process.env.ANTHROPIC_API_URL = url;

  const input = await llamarClaudeConTool('fake-key', dbFakeBajoPresupuesto, 'system', [{ role: 'user', content: 'hola' }], 'mecanico', null, tool);

  assert.deepEqual(input, { foo: 'bar' });
  assert.deepEqual(recibidos[0].tool_choice, { type: 'tool', name: 'mi_tool' });
  assert.equal(recibidos[0].tools[0].name, 'mi_tool');

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});

test('llamarClaudeConTool: lanza error si Claude no devuelve tool_use', async () => {
  const tool = { name: 'mi_tool', description: 'test', input_schema: { type: 'object', properties: {} } };
  const { server, url } = await crearServidorClaudeFake(() => ({
    content: [{ type: 'text', text: 'no debería pasar esto' }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
  process.env.ANTHROPIC_API_URL = url;

  await assert.rejects(
    () => llamarClaudeConTool('fake-key', dbFakeBajoPresupuesto, 'system', [{ role: 'user', content: 'hola' }], 'mecanico', null, tool),
    (err) => err.statusCode === 502
  );

  server.close();
  delete process.env.ANTHROPIC_API_URL;
});
