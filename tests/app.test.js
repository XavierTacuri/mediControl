'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');

// Base de datos aislada en memoria: estas pruebas no deben crear ni tocar
// data/medicontrol.db.
function withIsolatedApp(overrides = {}) {
  const dbPath = `:memory:`;
  const db = getDatabase(dbPath);
  const app = createApp({ db, demoMode: true, ...overrides });
  return { app, cleanup: () => closeDatabase(dbPath) };
}

test('GET /api/health responds 200 with the expected payload', async () => {
  const { app, cleanup } = withIsolatedApp();
  try {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok', application: 'MediControl', version: '1.0.0' });
  } finally {
    cleanup();
  }
});

test('unknown routes respond 404', async () => {
  const { app, cleanup } = withIsolatedApp();
  try {
    const res = await request(app).get('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.status, 'error');
  } finally {
    cleanup();
  }
});
