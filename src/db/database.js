'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createSchema } = require('./schema');

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'medicontrol.db');
const BUSY_TIMEOUT_MS = 5000;

// Conexiones reutilizables, indexadas por ruta resuelta, para evitar
// abrir el mismo archivo SQLite más de una vez (p.ej. entre tests).
const connections = new Map();

function resolveDbPath(dbPath) {
  if (!dbPath || dbPath === ':memory:') {
    return ':memory:';
  }
  return path.resolve(dbPath);
}

function configureConnection(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

/**
 * Devuelve una conexión SQLite reutilizable para `dbPath`, creando el
 * directorio contenedor y las tablas si todavía no existen. Pasar
 * ':memory:' (o una ruta temporal distinta por cada test) permite
 * aislar bases de datos de prueba sin afectar la base real.
 */
function getDatabase(dbPath = process.env.DATABASE_PATH || DEFAULT_DB_PATH) {
  const resolved = resolveDbPath(dbPath);

  const existing = connections.get(resolved);
  if (existing) {
    return existing;
  }

  if (resolved !== ':memory:') {
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = configureConnection(new Database(resolved));
  createSchema(db);
  connections.set(resolved, db);
  return db;
}

function closeDatabase(dbPath = process.env.DATABASE_PATH || DEFAULT_DB_PATH) {
  const resolved = resolveDbPath(dbPath);
  const db = connections.get(resolved);
  if (db) {
    db.close();
    connections.delete(resolved);
  }
}

function closeAllDatabases() {
  for (const db of connections.values()) {
    db.close();
  }
  connections.clear();
}

module.exports = {
  getDatabase,
  closeDatabase,
  closeAllDatabases,
  DEFAULT_DB_PATH,
};
