'use strict';

require('dotenv').config();

const { createApp } = require('./app');
const { loadConfig } = require('./config/env');
const { getDatabase, closeDatabase } = require('./db/database');

function start() {
  const config = loadConfig();

  let db;
  try {
    db = getDatabase(config.DATABASE_PATH);
  } catch (err) {
    console.error('Failed to initialize the database:', err.message);
    process.exitCode = 1;
    return null;
  }

  const app = createApp({ db });

  const server = app.listen(config.PORT, () => {
    console.log(`MediControl server listening at http://localhost:${config.PORT}`);
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    // Cierra las conexiones SSE abiertas ANTES de cerrar el servidor HTTP:
    // de lo contrario esas conexiones (que no terminan por sí solas)
    // mantendrían a server.close() esperando indefinidamente.
    app.get('appointmentBroker').closeAll();
    server.close(() => {
      closeDatabase(config.DATABASE_PATH);
      process.exit(0);
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { app, server, db };
}

if (require.main === module) {
  start();
}

module.exports = { start };
