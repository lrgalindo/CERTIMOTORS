import crypto from 'node:crypto';
import express from 'express';
import { verificarPresupuesto } from './budget-tracker.js';

// Backoffice de solo lectura para Rodrigo: órdenes, cola de jobs, gasto de
// Claude API y clientes. HTML server-rendered, sin frontend separado.
// Auth: HTTP Basic contra BACKOFFICE_USER/BACKOFFICE_PASS. Fail-closed: sin
// credenciales configuradas responde 503 en vez de quedar abierto.

function igualdadConstante(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export function basicAuth(req, res, next) {
  const user = process.env.BACKOFFICE_USER;
  const pass = process.env.BACKOFFICE_PASS;
  if (!user || !pass) {
    return res.status(503).send('Backoffice no configurado (BACKOFFICE_USER/BACKOFFICE_PASS)');
  }

  const header = req.get('authorization') || '';
  const [esquema, credenciales] = header.split(' ');
  if (esquema === 'Basic' && credenciales) {
    const [u, ...resto] = Buffer.from(credenciales, 'base64').toString().split(':');
    const p = resto.join(':');
    // Evaluar ambas comparaciones siempre (sin cortocircuito) para no filtrar
    // por timing cuál de las dos credenciales falló.
    const userOk = igualdadConstante(u, user);
    const passOk = igualdadConstante(p, pass);
    if (userOk && passOk) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="CERTIMOTORS backoffice"');
  return res.status(401).send('Autenticación requerida');
}

const esc = (v) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function tabla(titulo, columnas, filas) {
  const head = columnas.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = filas.length
    ? filas.map((f) => `<tr>${f.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('\n')
    : `<tr><td colspan="${columnas.length}"><em>Sin registros</em></td></tr>`;
  return `<h2>${esc(titulo)}</h2><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const fmtFecha = (v) => (v ? new Date(v).toLocaleString('es-GT', { timeZone: 'America/Guatemala' }) : '');

export function crearBackofficeRouter(db) {
  const router = express.Router();
  router.use(basicAuth);

  router.get('/', async (req, res, next) => {
    try {
      const filtroStatus = (req.query.status || '').toString().trim().toUpperCase() || null;
      const filtroPlaca = (req.query.placa || '').toString().trim().toUpperCase() || null;

      const [ordenes, jobs, clientes, presupuesto, statsHoy] = await Promise.all([
        db.listarOrdenes({ status: filtroStatus, placa: filtroPlaca, limite: 50 }),
        db.listarJobs(50),
        db.listarClientes(50),
        verificarPresupuesto(db),
        db.obtenerStatsReporte(),
      ]);

      const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>CERTIMOTORS backoffice</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#111}
  h1{font-size:20px} h2{font-size:16px;margin-top:28px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}
  th{background:#f3f4f6} tr:nth-child(even){background:#fafafa}
  form{margin:8px 0} input{padding:4px}
  .gasto{background:#f9fafb;border:1px solid #e5e7eb;padding:12px;border-radius:6px;display:inline-block}
</style></head><body>
<h1>CERTIMOTORS — backoffice (solo lectura)</h1>

<div class="gasto">
  <strong>Gasto Claude API</strong><br>
  Hoy: $${esc(statsHoy.gasto_dia_usd.toFixed(2))} ·
  Mes: $${esc(presupuesto.gastoMensual.toFixed(2))} / $${esc(presupuesto.limite)}
  (${esc(Math.round(presupuesto.porcentaje * 100))}%, nivel: ${esc(presupuesto.nivel)})
</div>

<form method="get">
  Filtrar órdenes — status: <input name="status" value="${esc(filtroStatus || '')}" placeholder="ESPERANDO_PAGO">
  placa: <input name="placa" value="${esc(filtroPlaca || '')}" placeholder="P926FTB">
  <button>Filtrar</button> <a href="?">limpiar</a>
</form>

${tabla('Órdenes (últimas 50)', ['Placa', 'Status', 'Servicio', 'Cliente', 'Creada', 'Actualizada'], ordenes.map((o) => [o.placa, o.status, o.servicio || '—', o.cliente_id, fmtFecha(o.created_at), fmtFecha(o.updated_at)]))}

${tabla('Cola de jobs (últimos 50)', ['Proveedor', 'Status', 'Intentos', 'Error', 'Creado', 'Actualizado'], jobs.map((j) => [j.proveedor, j.status, `${j.intentos}/${j.max_intentos}`, (j.error || '').slice(0, 120), fmtFecha(j.created_at), fmtFecha(j.updated_at)]))}

${tabla('Clientes (últimos 50)', ['Teléfono', 'Nombre', 'Registrado'], clientes.map((c) => [`+${c.numero_telefono}`, c.nombre, fmtFecha(c.created_at)]))}

</body></html>`;
      res.send(html);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
