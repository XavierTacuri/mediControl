'use strict';

const session = require('express-session');

/**
 * Almacén de sesiones persistente para express-session, respaldado por la
 * misma base SQLite de la aplicación (tabla `sessions`, ver src/db/schema.js).
 *
 * express-session usa MemoryStore por defecto, que pierde todas las
 * sesiones al reiniciar el proceso y no es apto para producción (así lo
 * advierte la propia librería). En vez de añadir una dependencia nueva
 * (connect-sqlite3, etc.), esta clase implementa la interfaz mínima de
 * `session.Store` (get/set/destroy/touch) sobre better-sqlite3, que ya es
 * una dependencia del proyecto.
 *
 * better-sqlite3 es síncrono; los callbacks de la interfaz Store se
 * invocan igualmente de forma asíncrona (vía microtask) para respetar el
 * contrato esperado por express-session y evitar código que dependa por
 * accidente de ejecución síncrona.
 */
class SqliteSessionStore extends session.Store {
  constructor({ db, ttlMs }) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
  }

  get(sid, callback) {
    queueMicrotask(() => {
      try {
        const row = this.db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
        if (!row) {
          return callback(null, null);
        }
        if (row.expires_at <= Date.now()) {
          this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
          return callback(null, null);
        }
        callback(null, JSON.parse(row.data));
      } catch (err) {
        callback(err);
      }
    });
  }

  set(sid, sessionData, callback) {
    queueMicrotask(() => {
      try {
        const expiresAt = Date.now() + this.ttlMs;
        const serialized = JSON.stringify(sessionData);
        this.db
          .prepare(
            `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
             ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
          )
          .run(sid, serialized, expiresAt);
        callback(null);
      } catch (err) {
        callback(err);
      }
    });
  }

  touch(sid, sessionData, callback) {
    this.set(sid, sessionData, callback);
  }

  destroy(sid, callback) {
    queueMicrotask(() => {
      try {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        callback(null);
      } catch (err) {
        callback(err);
      }
    });
  }

  // Limpieza de sesiones vencidas. No se llama automáticamente (no hay
  // temporizadores en segundo plano, para mantener el proceso fácil de
  // cerrar limpiamente, ver src/server.js); está pensada para invocarse
  // puntualmente (p. ej. en un script de mantenimiento futuro).
  clearExpired() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }
}

module.exports = { SqliteSessionStore };
