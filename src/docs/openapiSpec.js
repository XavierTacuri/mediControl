'use strict';

const path = require('node:path');
const swaggerJsdoc = require('swagger-jsdoc');

/**
 * Construye el documento OpenAPI 3.0 escaneando las anotaciones @openapi
 * de src/docs/openapi/*.js (archivos solo de documentación, sin lógica).
 * No inventa ningún endpoint: cada ruta documentada aquí corresponde a
 * una ruta real registrada en src/app.js / *.routes.js.
 */
const SECURITY_SCHEMES = {
  sessionCookie: {
    type: 'apiKey',
    in: 'cookie',
    name: 'medicontrol.sid',
    description:
      'Cookie de sesión HttpOnly emitida por POST /auth/login (ver src/app.js). ' +
      'No es un bearer token: el navegador la envía solo si la petición incluye credenciales ' +
      '("Send cookies" en Scalar, o credentials: "include" desde fetch/EventSource).',
  },
  csrfToken: {
    type: 'apiKey',
    in: 'header',
    name: 'X-CSRF-Token',
    description:
      'Obligatorio en toda petición que modifique datos (POST/PATCH/DELETE) una vez autenticado. ' +
      'Se obtiene del cuerpo de la respuesta de POST /auth/login o GET /auth/me (campo csrfToken) y ' +
      'debe reenviarse exactamente igual en esta cabecera (ver src/middlewares/csrf.js).',
  },
};

const COMMON_SCHEMAS = {
  Error: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'error' },
      message: { type: 'string', example: 'Resource not found' },
      details: {
        type: 'array',
        nullable: true,
        description: 'Solo presente en errores de validación de entrada (400).',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', example: 'first_name' },
            message: { type: 'string', example: 'Too small: expected string to have >=2 characters' },
          },
        },
      },
    },
    required: ['status', 'message'],
  },
};

const options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'MediControl API',
      version: '1.0.0',
      description:
        'API REST de MediControl (Unidad 2, proyecto académico). Gestión de pacientes y citas ' +
        'médicas con autenticación por sesión, RBAC por consultorio y notificaciones SSE. ' +
        'Usa exclusivamente datos ficticios; no apta para uso clínico real.',
    },
    servers: [{ url: '/api', description: 'Mismo origen que sirve la API (backend directo, o a través del proxy /api de Vite en desarrollo).' }],
    tags: [
      { name: 'Salud', description: 'Estado del servicio.' },
      { name: 'Autenticación', description: 'Login, logout, sesión actual y selección de consultorio.' },
      { name: 'Pacientes', description: 'Registro y gestión de pacientes de un consultorio.' },
      { name: 'Citas', description: 'Agendamiento y gestión de citas médicas.' },
      { name: 'Eventos en tiempo real', description: 'Notificaciones de citas vía Server-Sent Events.' },
    ],
    components: {
      securitySchemes: SECURITY_SCHEMES,
      schemas: COMMON_SCHEMAS,
    },
    // Por defecto toda operación requiere sesión + CSRF; cada operación
    // pública (health, login) lo sobrescribe con security: [] o
    // security: [{ sessionCookie: [] }] según corresponda.
    security: [{ sessionCookie: [], csrfToken: [] }],
  },
  // glob (usado internamente por swagger-jsdoc) interpreta '\' como
  // escape de patrón: en Windows, path.join() produce separadores '\' que
  // hacen que el glob no encuentre ningún archivo. Se normaliza a '/'
  // (válido también en POSIX) para que funcione en ambos sistemas.
  apis: [path.join(__dirname, 'openapi', '*.js').split(path.sep).join('/')],
};

// Memoizado: las anotaciones @openapi no cambian en caliente durante la
// vida de un proceso (un cambio en src/docs/openapi/*.js requiere
// reiniciar el servidor igual que cualquier otro archivo fuente, incluso
// con `--watch`). createApp() se llama una vez por cada prueba del
// backend (cientos de veces en la suite completa); sin memoizar, cada
// una repetiría el escaneo de archivos + parseo YAML de swagger-jsdoc sin
// ningún beneficio.
let cachedSpec = null;

function buildOpenApiSpec() {
  if (!cachedSpec) {
    cachedSpec = swaggerJsdoc(options);
  }
  return cachedSpec;
}

module.exports = { buildOpenApiSpec };
