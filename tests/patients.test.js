'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');
const { loadConfig } = require('../src/config/env');

const VALID_PATIENT = {
  first_name: 'Ana',
  last_name: 'Ejemplo',
  phone: '0991234567',
  email: 'ana@example.test',
};

// Cada prueba usa su propia base de datos SQLite en memoria (aislada):
// nunca se toca data/medicontrol.db.
function createIsolatedApp(overrides = {}) {
  const dbPath = ':memory:';
  const db = getDatabase(dbPath);
  const app = createApp({ db, demoMode: true, ...overrides });
  return { app, db, cleanup: () => closeDatabase(dbPath) };
}

// Crea un médico válido (con membresía 'doctor' en el consultorio) y una
// cita para `patientId`, reproduciendo lo que hará el futuro módulo de
// citas. Se usa SQL directo porque ese módulo todavía no existe (Fase 4).
function seedAppointmentForPatient(db, { clinicId, patientId }) {
  const doctorId = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run('Dr. Demo', `doctor-${patientId}@example.test`, 'hash').lastInsertRowid;

  db.prepare('INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES (?, ?, ?)').run(
    clinicId,
    doctorId,
    'doctor',
  );

  db.prepare(
    'INSERT INTO appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)',
  ).run(clinicId, patientId, doctorId, '2026-12-01T10:00:00.000Z', '2026-12-01T10:30:00.000Z');
}

test('registers a valid patient', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const res = await request(app).post('/api/patients').send(VALID_PATIENT);

    assert.equal(res.status, 201);
    assert.equal(res.body.first_name, 'Ana');
    assert.equal(res.body.last_name, 'Ejemplo');
    assert.equal(res.body.phone, '0991234567');
    assert.equal(res.body.email, 'ana@example.test');
    assert.ok(Number.isInteger(res.body.id));
    assert.equal(res.body.clinic_id, undefined, 'clinic_id must not be exposed to the client');
  } finally {
    cleanup();
  }
});

test('rejects an empty first_name', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const res = await request(app)
      .post('/api/patients')
      .send({ ...VALID_PATIENT, first_name: '' });

    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'error');
  } finally {
    cleanup();
  }
});

test('rejects an invalid email', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const res = await request(app)
      .post('/api/patients')
      .send({ ...VALID_PATIENT, email: 'not-an-email' });

    assert.equal(res.status, 400);
  } finally {
    cleanup();
  }
});

test('rejects unknown fields on creation', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const res = await request(app)
      .post('/api/patients')
      .send({ ...VALID_PATIENT, clinic_id: 999 });

    assert.equal(res.status, 400);
  } finally {
    cleanup();
  }
});

test('lists patients for the authorized clinic', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    await request(app).post('/api/patients').send(VALID_PATIENT);
    await request(app)
      .post('/api/patients')
      .send({ first_name: 'Luis', last_name: 'Prueba' });

    const res = await request(app).get('/api/patients');

    assert.equal(res.status, 200);
    assert.equal(res.body.patients.length, 2);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.page, 1);
  } finally {
    cleanup();
  }
});

test('retrieves an existing patient', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const created = await request(app).post('/api/patients').send(VALID_PATIENT);
    const res = await request(app).get(`/api/patients/${created.body.id}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.id, created.body.id);
  } finally {
    cleanup();
  }
});

test('returns 404 for a non-existent patient', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const res = await request(app).get('/api/patients/999999');
    assert.equal(res.status, 404);
  } finally {
    cleanup();
  }
});

test('updates a patient', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const created = await request(app).post('/api/patients').send(VALID_PATIENT);
    const res = await request(app).patch(`/api/patients/${created.body.id}`).send({ phone: '0987654321' });

    assert.equal(res.status, 200);
    assert.equal(res.body.phone, '0987654321');
    assert.equal(res.body.first_name, 'Ana');
  } finally {
    cleanup();
  }
});

test('rejects an empty update payload', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const created = await request(app).post('/api/patients').send(VALID_PATIENT);
    const res = await request(app).patch(`/api/patients/${created.body.id}`).send({});

    assert.equal(res.status, 422);
  } finally {
    cleanup();
  }
});

test('deletes a patient without appointments', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const created = await request(app).post('/api/patients').send(VALID_PATIENT);
    const del = await request(app).delete(`/api/patients/${created.body.id}`);
    assert.equal(del.status, 204);

    const after = await request(app).get(`/api/patients/${created.body.id}`);
    assert.equal(after.status, 404);
  } finally {
    cleanup();
  }
});

test('rejects deletion when the patient has appointments on record', async () => {
  const { app, db, cleanup } = createIsolatedApp();
  try {
    const created = await request(app).post('/api/patients').send(VALID_PATIENT);
    const clinicRow = db.prepare('SELECT clinic_id FROM patients WHERE id = ?').get(created.body.id);
    seedAppointmentForPatient(db, { clinicId: clinicRow.clinic_id, patientId: created.body.id });

    const res = await request(app).delete(`/api/patients/${created.body.id}`);
    assert.equal(res.status, 409);
  } finally {
    cleanup();
  }
});

test('searches patients by name', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    await request(app).post('/api/patients').send({ first_name: 'Ana', last_name: 'Ejemplo' });
    await request(app).post('/api/patients').send({ first_name: 'Luis', last_name: 'Prueba' });

    const res = await request(app).get('/api/patients').query({ search: 'ana' });

    assert.equal(res.status, 200);
    assert.equal(res.body.patients.length, 1);
    assert.equal(res.body.patients[0].first_name, 'Ana');
  } finally {
    cleanup();
  }
});

test('paginates results', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    for (let i = 1; i <= 5; i += 1) {
      await request(app)
        .post('/api/patients')
        .send({ first_name: `Paciente${i}`, last_name: 'Test' });
    }

    const res = await request(app).get('/api/patients').query({ page: 2, limit: 2 });

    assert.equal(res.status, 200);
    assert.equal(res.body.page, 2);
    assert.equal(res.body.limit, 2);
    assert.equal(res.body.total, 5);
    assert.equal(res.body.totalPages, 3);
    assert.equal(res.body.patients.length, 2);
  } finally {
    cleanup();
  }
});

test('isolates patients between clinics', async () => {
  const { db, cleanup } = createIsolatedApp();
  try {
    const clinicAId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Clinic A').lastInsertRowid;
    const clinicBId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Clinic B').lastInsertRowid;

    const appA = createApp({ db, demoMode: true, demoClinicId: clinicAId });
    const appB = createApp({ db, demoMode: true, demoClinicId: clinicBId });

    const created = await request(appA).post('/api/patients').send(VALID_PATIENT);
    assert.equal(created.status, 201);

    const getFromB = await request(appB).get(`/api/patients/${created.body.id}`);
    assert.equal(getFromB.status, 404);

    const listFromB = await request(appB).get('/api/patients');
    assert.equal(listFromB.body.total, 0);

    const patchFromB = await request(appB).patch(`/api/patients/${created.body.id}`).send({ phone: '0999999999' });
    assert.equal(patchFromB.status, 404);

    const deleteFromB = await request(appB).delete(`/api/patients/${created.body.id}`);
    assert.equal(deleteFromB.status, 404);
  } finally {
    cleanup();
  }
});

// Adaptado en la Fase 5: con demoMode:false, la rama de autenticación real
// (requireAuth) es la que decide — y una petición sin sesión es 401, no el
// 403 "demo deshabilitado" que respondía el viejo demoContext.js en la
// Fase 3/4 (ver src/app.js y tests/auth.test.js para la cobertura real de
// requireAuth/clinicContext).
test('rejects patient access when there is no session (real auth branch)', async () => {
  const { app, cleanup } = createIsolatedApp({ demoMode: false });
  try {
    const res = await request(app).get('/api/patients');
    assert.equal(res.status, 401);
    assert.equal(res.body.status, 'error');
  } finally {
    cleanup();
  }
});

test('forces the demo context off in production regardless of DEMO_MODE', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDemoMode = process.env.DEMO_MODE;
  const originalSessionSecret = process.env.SESSION_SECRET;
  try {
    process.env.NODE_ENV = 'production';
    process.env.DEMO_MODE = 'true';
    process.env.SESSION_SECRET = 'test-only-secret-not-used-for-anything-real';
    const config = loadConfig();
    assert.equal(config.DEMO_MODE, false);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalDemoMode === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = originalDemoMode;

    if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSessionSecret;
  }
});

// Fase 5: aunque alguien pasara demoMode:true explícitamente, en
// producción createApp() lo ignora (ver la guardia en src/app.js) y usa la
// rama de autenticación real de todos modos.
test('ignores an explicit demoMode:true override when NODE_ENV=production', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSessionSecret = process.env.SESSION_SECRET;
  const dbPath = ':memory:';
  try {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'test-only-secret-not-used-for-anything-real';
    const db = getDatabase(dbPath);
    const app = createApp({ db, demoMode: true, demoClinicId: 1 });

    const res = await request(app).get('/api/patients');
    assert.equal(res.status, 401);
  } finally {
    closeDatabase(dbPath);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSessionSecret;
  }
});
