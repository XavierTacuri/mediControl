'use strict';

const path = require('node:path');

const APP_NAME = 'MediControl';
const APP_VERSION = '1.0.0';

function loadConfig() {
  const NODE_ENV = process.env.NODE_ENV || 'development';
  const isProduction = NODE_ENV === 'production';

  // El modo DEMO sustituye a la autenticación real mientras esta no exista
  // (ver src/middlewares/demoContext.js). Por defecto está activo fuera de
  // producción y se puede desactivar explícitamente con DEMO_MODE=false.
  // En producción se fuerza a false sin excepción, sin importar el valor
  // de la variable de entorno: no hay autenticación real todavía, así que
  // no hay forma segura de ofrecer el modo DEMO fuera de un entorno local.
  const demoModeRequested = process.env.DEMO_MODE === undefined ? true : process.env.DEMO_MODE === 'true';

  // SESSION_SECRET firma la cookie de sesión (express-session). En
  // producción es obligatorio definirlo por variable de entorno: fallar
  // rápido en el arranque es preferible a correr con un secreto conocido.
  // Fuera de producción, se usa un valor fijo de desarrollo si no se
  // definió uno (sesiones solo locales, nunca persisten datos reales).
  if (isProduction && !process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET must be set via environment variables in production');
  }
  const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me-in-.env';

  return {
    APP_NAME,
    APP_VERSION,
    NODE_ENV,
    PORT: Number(process.env.PORT) || 3000,
    DATABASE_PATH: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'medicontrol.db'),
    DEMO_MODE: demoModeRequested && !isProduction,
    DEMO_CLINIC_NAME: process.env.DEMO_CLINIC_NAME || 'Consultorio Demo (Fase 3)',
    SESSION_SECRET,
    SESSION_TTL_MS: Number(process.env.SESSION_TTL_MS) || 30 * 60 * 1000,
    isProduction,
  };
}

module.exports = { loadConfig, APP_NAME, APP_VERSION };
