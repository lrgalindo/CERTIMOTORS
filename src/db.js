import sqlite3 from 'sqlite3';
import { v4 as uuidv4 } from 'uuid';

let db = null;

export async function initDB() {
  return new Promise((resolve, reject) => {
    const dbPath = process.env.DATABASE_PATH || './database.db';
    db = new sqlite3.Database(dbPath, async (err) => {
      if (err) return reject(err);
      db.run('PRAGMA foreign_keys = ON', async (err) => {
        if (err) return reject(err);
        await crearTablas();
        console.log('✅ Base de datos inicializada');
        resolve(db);
      });
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function crearTablas() {
  const schemas = [
    `CREATE TABLE IF NOT EXISTS clientes (
      id TEXT PRIMARY KEY,
      numero_telefono TEXT UNIQUE NOT NULL,
      nombre TEXT,
      tipo TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS ordenes (
      id TEXT PRIMARY KEY,
      placa TEXT UNIQUE NOT NULL,
      cliente_id TEXT NOT NULL,
      tipo_auto TEXT,
      status TEXT DEFAULT 'INICIADA',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    )`,
    `CREATE TABLE IF NOT EXISTS conversaciones (
      id TEXT PRIMARY KEY,
      placa TEXT NOT NULL,
      cliente_id TEXT NOT NULL,
      tipo_usuario TEXT,
      mensaje_entrada TEXT,
      respuesta_ia TEXT,
      tokens_usados INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (placa) REFERENCES ordenes(placa),
      FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    )`,
    `CREATE TABLE IF NOT EXISTS revisiones (
      id TEXT PRIMARY KEY,
      placa TEXT NOT NULL,
      mecanico_id TEXT,
      punto_actual INTEGER,
      respuesta TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (placa) REFERENCES ordenes(placa)
    )`,
    `CREATE TABLE IF NOT EXISTS notificaciones (
      id TEXT PRIMARY KEY,
      placa TEXT NOT NULL,
      tipo TEXT,
      mensaje TEXT,
      enviado BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (placa) REFERENCES ordenes(placa)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ordenes_placa ON ordenes(placa)`,
    `CREATE INDEX IF NOT EXISTS idx_ordenes_cliente ON ordenes(cliente_id)`,
    `CREATE INDEX IF NOT EXISTS idx_conversaciones_placa ON conversaciones(placa)`,
    `CREATE INDEX IF NOT EXISTS idx_revisiones_placa ON revisiones(placa)`,
  ];

  for (const sql of schemas) {
    await run(sql);
  }
}

export async function crearCliente(numero_telefono, data = {}) {
  const id = uuidv4();
  const { nombre = 'Cliente', tipo = 'CLIENTE' } = data;
  await run('INSERT INTO clientes (id, numero_telefono, nombre, tipo) VALUES (?, ?, ?, ?)', [
    id,
    numero_telefono,
    nombre,
    tipo,
  ]);
  return { id, numero_telefono, nombre, tipo };
}

export async function obtenerClientePorNumero(numero_telefono) {
  return get('SELECT * FROM clientes WHERE numero_telefono = ?', [numero_telefono]);
}

export async function crearOrden(placa, data = {}) {
  const id = uuidv4();
  const { cliente_id, tipo_auto = 'RODADO', status = 'INICIADA' } = data;
  await run(
    'INSERT INTO ordenes (id, placa, cliente_id, tipo_auto, status) VALUES (?, ?, ?, ?, ?)',
    [id, placa, cliente_id, tipo_auto, status]
  );
  return { id, placa, cliente_id, tipo_auto, status };
}

export async function obtenerOrdenPorPlaca(placa) {
  return get('SELECT * FROM ordenes WHERE placa = ?', [placa]);
}

export async function obtenerConversacionesPorPlaca(placa) {
  return all('SELECT * FROM conversaciones WHERE placa = ? ORDER BY created_at DESC LIMIT 10', [
    placa,
  ]);
}

export async function guardarConversacion(
  placa,
  cliente_id,
  tipo_usuario,
  mensaje_entrada,
  respuesta_ia,
  tokens = 0
) {
  const id = uuidv4();
  await run(
    `INSERT INTO conversaciones (id, placa, cliente_id, tipo_usuario, mensaje_entrada, respuesta_ia, tokens_usados)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, placa, cliente_id, tipo_usuario, mensaje_entrada, respuesta_ia, tokens]
  );
  return { id, placa, tipo_usuario, mensaje_entrada, respuesta_ia };
}

export async function guardarRevision(placa, mecanico_id, punto_actual, respuesta) {
  const id = uuidv4();
  await run(
    'INSERT INTO revisiones (id, placa, mecanico_id, punto_actual, respuesta) VALUES (?, ?, ?, ?, ?)',
    [id, placa, mecanico_id, punto_actual, respuesta]
  );
  return { id, placa, punto_actual, respuesta };
}

export async function obtenerRevisionesPorPlaca(placa) {
  return all('SELECT * FROM revisiones WHERE placa = ? ORDER BY punto_actual ASC', [placa]);
}

export async function crearNotificacion(placa, tipo, mensaje) {
  const id = uuidv4();
  await run('INSERT INTO notificaciones (id, placa, tipo, mensaje) VALUES (?, ?, ?, ?)', [
    id,
    placa,
    tipo,
    mensaje,
  ]);
  return { id, placa, tipo, mensaje };
}

export async function obtenerNotificacionesPendientes() {
  return all('SELECT * FROM notificaciones WHERE enviado = 0 ORDER BY created_at ASC');
}

export async function marcarNotificacionEnviada(id) {
  await run('UPDATE notificaciones SET enviado = 1 WHERE id = ?', [id]);
}

export async function obtenerEstadisticas() {
  const clientes = await get('SELECT COUNT(*) as total FROM clientes');
  const ordenes = await get('SELECT COUNT(*) as total FROM ordenes');
  const conversaciones = await get('SELECT COUNT(*) as total FROM conversaciones');
  const revisiones = await get('SELECT COUNT(*) as total FROM revisiones');
  return {
    clientes: clientes?.total || 0,
    ordenes: ordenes?.total || 0,
    conversaciones: conversaciones?.total || 0,
    revisiones: revisiones?.total || 0,
  };
}

export default { initDB, crearCliente, obtenerClientePorNumero, crearOrden, obtenerOrdenPorPlaca };
