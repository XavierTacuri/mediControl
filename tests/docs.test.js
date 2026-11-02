'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const SwaggerParser = require('@apidevtools/swagger-parser');

const { createApp } = require('../src/app');
const { buildOpenApiSpec } = require('../src/docs/openapiSpec');
const { getDatabase, closeDatabase } = require('../src/db/database');

const EXPECTED_PATHS = [
  '/health',
  '/auth/login',
  '/auth/logout',
  '/auth/me',
  '/auth/clinic',
  '/patients',
  '/patients/{id}',
  '/appointments',
  '/appointments/{id}',
  '/appointments/doctors',
  '/appointments/events',
];

function createIsolatedApp(overrides = {}) {
  const dbPath = ':memory:';
  const db = getDatabase(dbPath);
  const app = createApp({ db, demoMode: true, ...overrides });
  return { app, cleanup: () => closeDatabase(dbPath) };
}

test('builds a structurally valid OpenAPI document covering every real endpoint', () => {
  const spec = buildOpenApiSpec();

  assert.equal(spec.openapi, '3.0.3');
  assert.equal(spec.info.title, 'MediControl API');

  const documentedPaths = Object.keys(spec.paths);
  for (const expectedPath of EXPECTED_PATHS) {
    assert.ok(documentedPaths.includes(expectedPath), `missing documented path: ${expectedPath}`);
  }
  // Ningún endpoint inventado: el documento no debe tener más rutas que
  // las once que el backend realmente expone.
  assert.equal(documentedPaths.length, EXPECTED_PATHS.length);

  // Toda operación declara al menos una respuesta.
  for (const [pathName, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (method === 'parameters') continue;
      assert.ok(
        operation.responses && Object.keys(operation.responses).length > 0,
        `${method.toUpperCase()} ${pathName} has no documented responses`,
      );
    }
  }
});

test('the generated OpenAPI document passes full schema validation', async () => {
  const spec = buildOpenApiSpec();
  // swagger-parser muta/dereferencia el objeto que recibe; se le pasa una
  // copia para no afectar el spec cacheado que usan las rutas reales.
  await assert.doesNotReject(() => SwaggerParser.validate(JSON.parse(JSON.stringify(spec))));
});

test('documents cookie-session and CSRF-header security schemes', () => {
  const spec = buildOpenApiSpec();
  const schemes = spec.components.securitySchemes;

  assert.equal(schemes.sessionCookie.type, 'apiKey');
  assert.equal(schemes.sessionCookie.in, 'cookie');
  assert.equal(schemes.sessionCookie.name, 'medicontrol.sid');

  assert.equal(schemes.csrfToken.type, 'apiKey');
  assert.equal(schemes.csrfToken.in, 'header');
  assert.equal(schemes.csrfToken.name, 'X-CSRF-Token');
});

test('GET /api/openapi.json serves the OpenAPI document', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const res = await request(app).get('/api/openapi.json');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(res.body.openapi, '3.0.3');
    assert.ok(res.body.paths['/patients']);
  } finally {
    cleanup();
  }
});

test('GET /api/docs serves the Scalar reference page', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const res = await request(app).get('/api/docs');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /MediControl API Reference/);
    assert.match(res.text, /openapi\.json/);
  } finally {
    cleanup();
  }
});

test('does not require authentication to read the documentation itself', async () => {
  // Las rutas de documentación son públicas (dentro de un entorno no
  // productivo): no pasan por requireAuth/clinicContext ni por el
  // contexto DEMO, así que deben responder igual con o sin sesión.
  const { app, cleanup } = createIsolatedApp({ demoMode: false });
  try {
    const openapi = await request(app).get('/api/openapi.json');
    const docs = await request(app).get('/api/docs');
    assert.equal(openapi.status, 200);
    assert.equal(docs.status, 200);
  } finally {
    cleanup();
  }
});

test('disables both documentation routes when explicitly turned off', async () => {
  const { app, cleanup } = createIsolatedApp({ enableDocs: false });
  try {
    const openapi = await request(app).get('/api/openapi.json');
    const docs = await request(app).get('/api/docs');
    assert.equal(openapi.status, 404);
    assert.equal(docs.status, 404);
  } finally {
    cleanup();
  }
});

test('forces the documentation routes off in production regardless of enableDocs', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSessionSecret = process.env.SESSION_SECRET;
  const dbPath = ':memory:';
  try {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'test-only-secret-not-used-for-anything-real';
    const db = getDatabase(dbPath);
    const app = createApp({ db, demoMode: false, enableDocs: true });

    const openapi = await request(app).get('/api/openapi.json');
    const docs = await request(app).get('/api/docs');
    assert.equal(openapi.status, 404);
    assert.equal(docs.status, 404);

    // /api/health, que sí es público en producción, sigue respondiendo.
    const health = await request(app).get('/api/health');
    assert.equal(health.status, 200);
  } finally {
    closeDatabase(dbPath);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSessionSecret;
  }
});
