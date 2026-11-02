'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');

// Reloj fijo e inyectable: "ahora" = 2026-06-15T12:00:00Z. Permite que la
// prueba de "cita en el pasado" sea determinista sin depender de la fecha
// real del sistema (ver appointments.service.js / createApp({ clock })).
const FIXED_NOW = new Date('2026-06-15T12:00:00.000Z');
const FIXED_CLOCK = { now: () => FIXED_NOW };

let emailCounter = 0;
function uniqueEmail(prefix) {
  emailCounter += 1;
  return `${prefix}-${emailCounter}@example.test`;
}

// Cada prueba usa su propia base de datos SQLite en memoria (aislada) y un
// consultorio DEMO fijo y conocido, para poder sembrar pacientes/médicos
// directamente por SQL sin depender de otros módulos.
function createIsolatedApp(overrides = {}) {
  const dbPath = ':memory:';
  const db = getDatabase(dbPath);
  const clinicId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Clinic Demo').lastInsertRowid;
  const app = createApp({ db, demoMode: true, demoClinicId: clinicId, clock: FIXED_CLOCK, ...overrides });
  return { app, db, clinicId, cleanup: () => closeDatabase(dbPath) };
}

function seedPatient(db, clinicId, { firstName = 'Paciente', lastName = 'Demo' } = {}) {
  return db
    .prepare('INSERT INTO patients (clinic_id, first_name, last_name) VALUES (?, ?, ?)')
    .run(clinicId, firstName, lastName).lastInsertRowid;
}

function seedDoctor(db, clinicId, { active = 1, role = 'doctor' } = {}) {
  const doctorId = db
    .prepare('INSERT INTO users (name, email, password_hash, active) VALUES (?, ?, ?, ?)')
    .run('Dr. Demo', uniqueEmail('doctor'), 'hash', active).lastInsertRowid;

  if (role) {
    db.prepare('INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES (?, ?, ?)').run(
      clinicId,
      doctorId,
      role,
    );
  }
  return doctorId;
}

function validAppointmentPayload({ patientId, doctorId, startsAt = '2030-01-10T14:00:00Z', endsAt = '2030-01-10T14:30:00Z' }) {
  return { patient_id: patientId, doctor_id: doctorId, starts_at: startsAt, ends_at: endsAt };
}

test('creates a valid appointment', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);

    const res = await request(app).post('/api/appointments').send(validAppointmentPayload({ patientId, doctorId }));

    assert.equal(res.status, 201);
    assert.equal(res.body.patient_id, patientId);
    assert.equal(res.body.doctor_id, doctorId);
    assert.equal(res.body.status, 'scheduled');
    assert.equal(res.body.starts_at, '2030-01-10T14:00:00.000Z');
  } finally {
    cleanup();
  }
});

test('rejects a non-existent patient', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const doctorId = seedDoctor(db, clinicId);
    const res = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId: 999999, doctorId }));

    assert.equal(res.status, 422);
  } finally {
    cleanup();
  }
});

test('rejects a non-existent doctor', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const res = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId: 999999 }));

    assert.equal(res.status, 422);
  } finally {
    cleanup();
  }
});

test('rejects a user without the doctor role', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const secretaryId = seedDoctor(db, clinicId, { role: 'secretary' });

    const res = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId: secretaryId }));

    assert.equal(res.status, 422);
  } finally {
    cleanup();
  }
});

test('rejects a doctor that belongs to a different clinic', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const otherClinicId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Other Clinic').lastInsertRowid;
    const doctorId = seedDoctor(db, otherClinicId);

    const res = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId }));

    assert.equal(res.status, 422);
  } finally {
    cleanup();
  }
});

test('rejects a patient that belongs to a different clinic', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const doctorId = seedDoctor(db, clinicId);
    const otherClinicId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Other Clinic').lastInsertRowid;
    const patientId = seedPatient(db, otherClinicId);

    const res = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId }));

    assert.equal(res.status, 422);
  } finally {
    cleanup();
  }
});

test('rejects an invalid date', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);

    const res = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: 'not-a-date' }));

    assert.equal(res.status, 400);
  } finally {
    cleanup();
  }
});

test('rejects an invalid interval (ends_at <= starts_at)', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);

    const res = await request(app)
      .post('/api/appointments')
      .send(
        validAppointmentPayload({
          patientId,
          doctorId,
          startsAt: '2030-01-10T14:30:00Z',
          endsAt: '2030-01-10T14:00:00Z',
        }),
      );

    assert.equal(res.status, 400);
  } finally {
    cleanup();
  }
});

test('rejects an appointment scheduled in the past', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);

    const res = await request(app)
      .post('/api/appointments')
      .send(
        validAppointmentPayload({
          patientId,
          doctorId,
          startsAt: '2026-06-14T10:00:00Z',
          endsAt: '2026-06-14T10:30:00Z',
        }),
      );

    assert.equal(res.status, 422);
  } finally {
    cleanup();
  }
});

test('detects an overlapping appointment for the same doctor', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);

    const first = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-10T14:00:00Z', endsAt: '2030-01-10T14:30:00Z' }));
    assert.equal(first.status, 201);

    const second = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-10T14:15:00Z', endsAt: '2030-01-10T14:45:00Z' }));

    assert.equal(second.status, 409);
  } finally {
    cleanup();
  }
});

test('allows back-to-back appointments for the same doctor', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);

    const first = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-10T14:00:00Z', endsAt: '2030-01-10T14:30:00Z' }));
    assert.equal(first.status, 201);

    const second = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-10T14:30:00Z', endsAt: '2030-01-10T15:00:00Z' }));

    assert.equal(second.status, 201);
  } finally {
    cleanup();
  }
});

test('lists appointments for the authorized clinic', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);

    await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-10T14:00:00Z', endsAt: '2030-01-10T14:30:00Z' }));
    await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-11T14:00:00Z', endsAt: '2030-01-11T14:30:00Z' }));

    const res = await request(app).get('/api/appointments');

    assert.equal(res.status, 200);
    assert.equal(res.body.appointments.length, 2);
    assert.equal(res.body.total, 2);
  } finally {
    cleanup();
  }
});

test('filters appointments by doctor', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorA = seedDoctor(db, clinicId);
    const doctorB = seedDoctor(db, clinicId);

    await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId: doctorA, startsAt: '2030-01-10T14:00:00Z', endsAt: '2030-01-10T14:30:00Z' }));
    await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId: doctorB, startsAt: '2030-01-10T15:00:00Z', endsAt: '2030-01-10T15:30:00Z' }));

    const res = await request(app).get('/api/appointments').query({ doctor_id: doctorA });

    assert.equal(res.status, 200);
    assert.equal(res.body.appointments.length, 1);
    assert.equal(res.body.appointments[0].doctor_id, doctorA);
  } finally {
    cleanup();
  }
});

test('filters appointments by patient', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientA = seedPatient(db, clinicId, { firstName: 'A' });
    const patientB = seedPatient(db, clinicId, { firstName: 'B' });
    const doctorId = seedDoctor(db, clinicId);

    await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId: patientA, doctorId, startsAt: '2030-01-10T14:00:00Z', endsAt: '2030-01-10T14:30:00Z' }));
    await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId: patientB, doctorId, startsAt: '2030-01-10T15:00:00Z', endsAt: '2030-01-10T15:30:00Z' }));

    const res = await request(app).get('/api/appointments').query({ patient_id: patientB });

    assert.equal(res.status, 200);
    assert.equal(res.body.appointments.length, 1);
    assert.equal(res.body.appointments[0].patient_id, patientB);
  } finally {
    cleanup();
  }
});

test('filters appointments by status', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);

    const created = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-10T14:00:00Z', endsAt: '2030-01-10T14:30:00Z' }));
    await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-11T14:00:00Z', endsAt: '2030-01-11T14:30:00Z' }));

    await request(app).delete(`/api/appointments/${created.body.id}`);

    const res = await request(app).get('/api/appointments').query({ status: 'cancelled' });

    assert.equal(res.status, 200);
    assert.equal(res.body.appointments.length, 1);
    assert.equal(res.body.appointments[0].id, created.body.id);
  } finally {
    cleanup();
  }
});

test('filters appointments by date range', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);

    await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-05T14:00:00Z', endsAt: '2030-01-05T14:30:00Z' }));
    const inRange = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-15T14:00:00Z', endsAt: '2030-01-15T14:30:00Z' }));
    await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-25T14:00:00Z', endsAt: '2030-01-25T14:30:00Z' }));

    const res = await request(app)
      .get('/api/appointments')
      .query({ from: '2030-01-10T00:00:00Z', to: '2030-01-20T00:00:00Z' });

    assert.equal(res.status, 200);
    assert.equal(res.body.appointments.length, 1);
    assert.equal(res.body.appointments[0].id, inRange.body.id);
  } finally {
    cleanup();
  }
});

test('paginates appointment results', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);

    for (let i = 1; i <= 5; i += 1) {
      await request(app)
        .post('/api/appointments')
        .send(
          validAppointmentPayload({
            patientId,
            doctorId,
            startsAt: `2030-02-0${i}T14:00:00Z`,
            endsAt: `2030-02-0${i}T14:30:00Z`,
          }),
        );
    }

    const res = await request(app).get('/api/appointments').query({ page: 2, limit: 2 });

    assert.equal(res.status, 200);
    assert.equal(res.body.page, 2);
    assert.equal(res.body.total, 5);
    assert.equal(res.body.totalPages, 3);
    assert.equal(res.body.appointments.length, 2);
  } finally {
    cleanup();
  }
});

test('retrieves a single appointment and 404s for a non-existent one', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);
    const created = await request(app).post('/api/appointments').send(validAppointmentPayload({ patientId, doctorId }));

    const found = await request(app).get(`/api/appointments/${created.body.id}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.id, created.body.id);

    const missing = await request(app).get('/api/appointments/999999');
    assert.equal(missing.status, 404);
  } finally {
    cleanup();
  }
});

test('reschedules an appointment', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);
    const created = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-10T14:00:00Z', endsAt: '2030-01-10T14:30:00Z' }));

    const res = await request(app)
      .patch(`/api/appointments/${created.body.id}`)
      .send({ starts_at: '2030-01-10T16:00:00Z', ends_at: '2030-01-10T16:30:00Z' });

    assert.equal(res.status, 200);
    assert.equal(res.body.starts_at, '2030-01-10T16:00:00.000Z');
    assert.equal(res.body.ends_at, '2030-01-10T16:30:00.000Z');
  } finally {
    cleanup();
  }
});

test('rejects an overlapping reschedule', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);

    const a = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-10T14:00:00Z', endsAt: '2030-01-10T14:30:00Z' }));
    const b = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-10T16:00:00Z', endsAt: '2030-01-10T16:30:00Z' }));
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    const res = await request(app)
      .patch(`/api/appointments/${b.body.id}`)
      .send({ starts_at: '2030-01-10T14:15:00Z', ends_at: '2030-01-10T14:45:00Z' });

    assert.equal(res.status, 409);
  } finally {
    cleanup();
  }
});

test('confirms a scheduled appointment', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);
    const created = await request(app).post('/api/appointments').send(validAppointmentPayload({ patientId, doctorId }));

    const res = await request(app).patch(`/api/appointments/${created.body.id}`).send({ status: 'confirmed' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'confirmed');
  } finally {
    cleanup();
  }
});

test('completes a confirmed appointment', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);
    const created = await request(app).post('/api/appointments').send(validAppointmentPayload({ patientId, doctorId }));
    await request(app).patch(`/api/appointments/${created.body.id}`).send({ status: 'confirmed' });

    const res = await request(app).patch(`/api/appointments/${created.body.id}`).send({ status: 'completed' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'completed');
  } finally {
    cleanup();
  }
});

test('cancels an appointment via DELETE (logical cancellation, not a hard delete)', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);
    const created = await request(app).post('/api/appointments').send(validAppointmentPayload({ patientId, doctorId }));

    const del = await request(app).delete(`/api/appointments/${created.body.id}`);
    assert.equal(del.status, 204);

    const after = await request(app).get(`/api/appointments/${created.body.id}`);
    assert.equal(after.status, 200);
    assert.equal(after.body.status, 'cancelled');
  } finally {
    cleanup();
  }
});

test('frees up the time slot when an appointment is cancelled', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);
    const created = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-10T14:00:00Z', endsAt: '2030-01-10T14:30:00Z' }));

    await request(app).delete(`/api/appointments/${created.body.id}`);

    const res = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-10T14:00:00Z', endsAt: '2030-01-10T14:30:00Z' }));

    assert.equal(res.status, 201);
  } finally {
    cleanup();
  }
});

test('rejects rescheduling a completed appointment', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);
    const created = await request(app).post('/api/appointments').send(validAppointmentPayload({ patientId, doctorId }));
    await request(app).patch(`/api/appointments/${created.body.id}`).send({ status: 'confirmed' });
    await request(app).patch(`/api/appointments/${created.body.id}`).send({ status: 'completed' });

    const res = await request(app)
      .patch(`/api/appointments/${created.body.id}`)
      .send({ starts_at: '2030-02-01T10:00:00Z', ends_at: '2030-02-01T10:30:00Z' });

    assert.equal(res.status, 409);
  } finally {
    cleanup();
  }
});

test('rejects an invalid status transition between non-terminal states', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);
    const created = await request(app).post('/api/appointments').send(validAppointmentPayload({ patientId, doctorId }));
    await request(app).patch(`/api/appointments/${created.body.id}`).send({ status: 'confirmed' });

    const res = await request(app).patch(`/api/appointments/${created.body.id}`).send({ status: 'scheduled' });

    assert.equal(res.status, 409);
  } finally {
    cleanup();
  }
});

test('rejects an empty reschedule payload', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);
    const created = await request(app).post('/api/appointments').send(validAppointmentPayload({ patientId, doctorId }));

    const res = await request(app).patch(`/api/appointments/${created.body.id}`).send({});

    assert.equal(res.status, 422);
  } finally {
    cleanup();
  }
});

test('rejects cross-clinic access to an appointment', async () => {
  const { db, cleanup } = createIsolatedApp();
  try {
    const clinicAId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Clinic A').lastInsertRowid;
    const clinicBId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Clinic B').lastInsertRowid;

    const patientId = seedPatient(db, clinicAId);
    const doctorId = seedDoctor(db, clinicAId);

    const appA = createApp({ db, demoMode: true, demoClinicId: clinicAId, clock: FIXED_CLOCK });
    const appB = createApp({ db, demoMode: true, demoClinicId: clinicBId, clock: FIXED_CLOCK });

    const created = await request(appA).post('/api/appointments').send(validAppointmentPayload({ patientId, doctorId }));
    assert.equal(created.status, 201);

    const getFromB = await request(appB).get(`/api/appointments/${created.body.id}`);
    assert.equal(getFromB.status, 404);

    const patchFromB = await request(appB)
      .patch(`/api/appointments/${created.body.id}`)
      .send({ status: 'confirmed' });
    assert.equal(patchFromB.status, 404);

    const deleteFromB = await request(appB).delete(`/api/appointments/${created.body.id}`);
    assert.equal(deleteFromB.status, 404);
  } finally {
    cleanup();
  }
});

// Adaptado en la Fase 5: con demoMode:false la rama de autenticación real
// decide, y una petición sin sesión es 401 (ver tests/auth.test.js y
// tests/rbac.test.js para la cobertura completa de requireAuth/RBAC sobre
// este mismo endpoint).
test('rejects appointment access when there is no session (real auth branch)', async () => {
  const { app, cleanup } = createIsolatedApp({ demoMode: false });
  try {
    const res = await request(app).get('/api/appointments');
    assert.equal(res.status, 401);
    assert.equal(res.body.status, 'error');
  } finally {
    cleanup();
  }
});

test('cancellation is idempotent', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);
    const created = await request(app).post('/api/appointments').send(validAppointmentPayload({ patientId, doctorId }));

    const first = await request(app).delete(`/api/appointments/${created.body.id}`);
    const second = await request(app).delete(`/api/appointments/${created.body.id}`);

    assert.equal(first.status, 204);
    assert.equal(second.status, 204);

    const after = await request(app).get(`/api/appointments/${created.body.id}`);
    assert.equal(after.body.status, 'cancelled');
  } finally {
    cleanup();
  }
});

// Corrección de Fase 5 (sección 12): crear una cita en el pasado ya se
// rechazaba desde la Fase 4, pero reprogramarla hacia el pasado no se
// revalidaba. Usa el mismo reloj fijo (FIXED_NOW = 2026-06-15T12:00:00Z)
// que el resto del archivo para ser determinista.
test('rejects rescheduling an appointment to a start time in the past', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);
    const created = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2030-01-10T14:00:00Z', endsAt: '2030-01-10T14:30:00Z' }));

    const res = await request(app)
      .patch(`/api/appointments/${created.body.id}`)
      .send({ starts_at: '2026-06-14T10:00:00Z', ends_at: '2026-06-14T10:30:00Z' });

    assert.equal(res.status, 422);
  } finally {
    cleanup();
  }
});

// Cambiar solo el estado (sin tocar el horario) de una cita cuya hora ya
// pasó con el avance normal del reloj NO debe bloquearse por esta misma
// regla: solo se revalida "no pasado" cuando el horario realmente cambia.
test('allows a status-only change on an appointment whose time has already elapsed', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const patientId = seedPatient(db, clinicId);
    const doctorId = seedDoctor(db, clinicId);
    const created = await request(app)
      .post('/api/appointments')
      .send(validAppointmentPayload({ patientId, doctorId, startsAt: '2026-06-15T13:00:00Z', endsAt: '2026-06-15T13:30:00Z' }));
    assert.equal(created.status, 201);

    const laterApp = createApp({
      db,
      demoMode: true,
      demoClinicId: clinicId,
      clock: { now: () => new Date('2026-06-15T14:00:00Z') },
    });
    const res = await request(laterApp).patch(`/api/appointments/${created.body.id}`).send({ status: 'confirmed' });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'confirmed');
  } finally {
    cleanup();
  }
});

// Fase 7: el frontend necesita un selector de médicos autorizados para el
// formulario de citas; no existía ningún endpoint para listarlos.
test('lists active doctors in the authorized clinic', async () => {
  const { app, db, clinicId, cleanup } = createIsolatedApp();
  try {
    const doctorId = seedDoctor(db, clinicId);
    const inactiveDoctorId = seedDoctor(db, clinicId);
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(inactiveDoctorId);

    const res = await request(app).get('/api/appointments/doctors');

    assert.equal(res.status, 200);
    assert.equal(res.body.doctors.length, 1);
    assert.equal(res.body.doctors[0].id, doctorId);
    assert.ok('name' in res.body.doctors[0]);
  } finally {
    cleanup();
  }
});

test('does not list doctors from another clinic', async () => {
  const { db, cleanup } = createIsolatedApp();
  try {
    const clinicAId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Clinic A').lastInsertRowid;
    const clinicBId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Clinic B').lastInsertRowid;
    seedDoctor(db, clinicBId);

    const appA = createApp({ db, demoMode: true, demoClinicId: clinicAId });
    const res = await request(appA).get('/api/appointments/doctors');

    assert.equal(res.status, 200);
    assert.equal(res.body.doctors.length, 0);
  } finally {
    cleanup();
  }
});
