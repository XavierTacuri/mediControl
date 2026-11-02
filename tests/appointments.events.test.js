'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');
const { AppointmentBroker } = require('../src/events/appointmentBroker');
const { connectSse, cookieHeaderFrom, wait } = require('./helpers/sse');
const { seedClinic, seedUser, seedMembership, seedPatient } = require('./helpers/authSeed');

// Heartbeat/revalidación rápidos para que las pruebas de "sesión revocada
// durante la conexión" no tengan que esperar segundos reales.
const FAST_HEARTBEAT_MS = 40;

function createIsolatedApp(overrides = {}) {
  const dbPath = ':memory:';
  const db = getDatabase(dbPath);
  const broker = overrides.appointmentBroker || new AppointmentBroker();
  const app = createApp({
    db,
    demoMode: false,
    sseHeartbeatMs: FAST_HEARTBEAT_MS,
    appointmentBroker: broker,
    ...overrides,
  });
  const server = app.listen(0);

  return {
    app,
    db,
    broker,
    server,
    cleanup: () =>
      new Promise((resolve) => {
        broker.closeAll();
        server.close(() => {
          closeDatabase(dbPath);
          resolve();
        });
      }),
  };
}

async function loginAs(app, user) {
  const res = await request(app).post('/api/auth/login').send({ email: user.email, password: user.password });
  assert.equal(res.status, 200, `login as ${user.email} should succeed`);
  return { cookie: cookieHeaderFrom(res.headers['set-cookie']), csrfToken: res.body.csrfToken, body: res.body };
}

// Siembra un consultorio con una secretaria (agenda completa) y un médico,
// más un paciente; inicia sesión como la secretaria. Suficiente para la
// mayoría de las pruebas de "se emite el evento X", donde el alcance por
// médico no es lo que se está probando.
async function setupClinicWithSecretary(db, app) {
  const clinicId = seedClinic(db, 'Clinic A');
  const secretary = seedUser(db, { password: 'correct-password' });
  seedMembership(db, { clinicId, userId: secretary.id, role: 'secretary' });
  const doctor = seedUser(db, { password: 'correct-password' });
  seedMembership(db, { clinicId, userId: doctor.id, role: 'doctor' });
  const patientId = seedPatient(db, clinicId);
  const session = await loginAs(app, secretary);

  async function createAppointment(overrides = {}) {
    const res = await request(app)
      .post('/api/appointments')
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrfToken)
      .send({
        patient_id: patientId,
        doctor_id: doctor.id,
        starts_at: '2030-01-10T14:00:00Z',
        ends_at: '2030-01-10T14:30:00Z',
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  }

  function patch(id, body) {
    return request(app)
      .patch(`/api/appointments/${id}`)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrfToken)
      .send(body);
  }

  function cancel(id) {
    return request(app).delete(`/api/appointments/${id}`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrfToken);
  }

  return { clinicId, secretary, doctor, patientId, session, createAppointment, patch, cancel };
}

test('opens an authenticated SSE connection', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctor.id, role: 'doctor' });
    const { cookie } = await loginAs(app, doctor);

    const conn = await connectSse({ server, path: '/api/appointments/events', cookie });
    assert.equal(conn.statusCode, 200);
    conn.close();
  } finally {
    await cleanup();
  }
});

test('rejects an unauthenticated connection', async () => {
  const { server, cleanup } = createIsolatedApp();
  try {
    const conn = await connectSse({ server, path: '/api/appointments/events' });
    assert.equal(conn.statusCode, 401);
  } finally {
    await cleanup();
  }
});

test('rejects a connection with no authorized clinic selected', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicA = seedClinic(db, 'Clinic A');
    const clinicB = seedClinic(db, 'Clinic B');
    const doctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId: clinicA, userId: doctor.id, role: 'doctor' });
    seedMembership(db, { clinicId: clinicB, userId: doctor.id, role: 'doctor' });
    const { cookie } = await loginAs(app, doctor);

    const conn = await connectSse({ server, path: '/api/appointments/events', cookie });
    assert.equal(conn.statusCode, 403);
  } finally {
    await cleanup();
  }
});

test('rejects a user without appointments:read permission', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const nurse = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: nurse.id, role: 'nurse' });
    const { cookie } = await loginAs(app, nurse);

    const conn = await connectSse({ server, path: '/api/appointments/events', cookie });
    assert.equal(conn.statusCode, 403);
  } finally {
    await cleanup();
  }
});

test('responds with the text/event-stream content type', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctor.id, role: 'doctor' });
    const { cookie } = await loginAs(app, doctor);

    const conn = await connectSse({ server, path: '/api/appointments/events', cookie });
    assert.match(conn.headers['content-type'], /text\/event-stream/);
    conn.close();
  } finally {
    await cleanup();
  }
});

test('emits appointment.created when a new appointment is booked', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const { session, createAppointment } = await setupClinicWithSecretary(db, app);
    const conn = await connectSse({ server, path: '/api/appointments/events', cookie: session.cookie });

    const created = await createAppointment();

    const event = await conn.waitFor((e) => e.type === 'appointment.created');
    assert.equal(event.data.appointment_id, created.id);
    assert.equal(event.data.status, 'scheduled');
    conn.close();
  } finally {
    await cleanup();
  }
});

test('emits appointment.updated when an appointment is confirmed', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const { session, createAppointment, patch } = await setupClinicWithSecretary(db, app);
    const created = await createAppointment();
    const conn = await connectSse({ server, path: '/api/appointments/events', cookie: session.cookie });

    const res = await patch(created.id, { status: 'confirmed' });
    assert.equal(res.status, 200);

    const event = await conn.waitFor((e) => e.type === 'appointment.updated');
    assert.equal(event.data.status, 'confirmed');
    conn.close();
  } finally {
    await cleanup();
  }
});

test('emits appointment.updated when an appointment is rescheduled', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const { session, createAppointment, patch } = await setupClinicWithSecretary(db, app);
    const created = await createAppointment();
    const conn = await connectSse({ server, path: '/api/appointments/events', cookie: session.cookie });

    const res = await patch(created.id, { starts_at: '2030-01-10T16:00:00Z', ends_at: '2030-01-10T16:30:00Z' });
    assert.equal(res.status, 200);

    const event = await conn.waitFor((e) => e.type === 'appointment.updated' && e.data.appointment_id === created.id);
    assert.equal(event.data.status, 'scheduled');
    conn.close();
  } finally {
    await cleanup();
  }
});

test('emits appointment.cancelled when an appointment is cancelled', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const { session, createAppointment, cancel } = await setupClinicWithSecretary(db, app);
    const created = await createAppointment();
    const conn = await connectSse({ server, path: '/api/appointments/events', cookie: session.cookie });

    const res = await cancel(created.id);
    assert.equal(res.status, 204);

    const event = await conn.waitFor((e) => e.type === 'appointment.cancelled');
    assert.equal(event.data.status, 'cancelled');
    conn.close();
  } finally {
    await cleanup();
  }
});

test('emits appointment.completed when a confirmed appointment is completed', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const { session, createAppointment, patch } = await setupClinicWithSecretary(db, app);
    const created = await createAppointment();
    await patch(created.id, { status: 'confirmed' });
    const conn = await connectSse({ server, path: '/api/appointments/events', cookie: session.cookie });

    const res = await patch(created.id, { status: 'completed' });
    assert.equal(res.status, 200);

    const event = await conn.waitFor((e) => e.type === 'appointment.completed');
    assert.equal(event.data.status, 'completed');
    conn.close();
  } finally {
    await cleanup();
  }
});

test('does not emit an event when the operation fails', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const { session } = await setupClinicWithSecretary(db, app);
    const conn = await connectSse({ server, path: '/api/appointments/events', cookie: session.cookie });

    const failed = await request(app)
      .post('/api/appointments')
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrfToken)
      .send({ patient_id: 999999, doctor_id: 999999, starts_at: '2030-01-10T14:00:00Z', ends_at: '2030-01-10T14:30:00Z' });
    assert.equal(failed.status, 422);

    await wait(150);
    assert.equal(conn.events.length, 0);
    conn.close();
  } finally {
    await cleanup();
  }
});

test('does not emit a duplicate event for an idempotent no-op cancellation', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const { session, createAppointment, cancel } = await setupClinicWithSecretary(db, app);
    const created = await createAppointment();
    const conn = await connectSse({ server, path: '/api/appointments/events', cookie: session.cookie });

    const first = await cancel(created.id);
    const second = await cancel(created.id);
    assert.equal(first.status, 204);
    assert.equal(second.status, 204);

    await conn.waitFor((e) => e.type === 'appointment.cancelled');
    await wait(150);
    const cancellations = conn.events.filter((e) => e.type === 'appointment.cancelled');
    assert.equal(cancellations.length, 1);
    conn.close();
  } finally {
    await cleanup();
  }
});

test('isolates events between clinics', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicA = seedClinic(db, 'Clinic A');
    const clinicB = seedClinic(db, 'Clinic B');

    const secretaryA = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId: clinicA, userId: secretaryA.id, role: 'secretary' });
    const sessionA = await loginAs(app, secretaryA);
    const connA = await connectSse({ server, path: '/api/appointments/events', cookie: sessionA.cookie });

    const secretaryB = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId: clinicB, userId: secretaryB.id, role: 'secretary' });
    const doctorB = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId: clinicB, userId: doctorB.id, role: 'doctor' });
    const patientB = seedPatient(db, clinicB);
    const sessionB = await loginAs(app, secretaryB);

    const created = await request(app)
      .post('/api/appointments')
      .set('Cookie', sessionB.cookie)
      .set('X-CSRF-Token', sessionB.csrfToken)
      .send({ patient_id: patientB, doctor_id: doctorB.id, starts_at: '2030-01-10T14:00:00Z', ends_at: '2030-01-10T14:30:00Z' });
    assert.equal(created.status, 201);

    await wait(150);
    assert.equal(connA.events.length, 0);
    connA.close();
  } finally {
    await cleanup();
  }
});

test('a doctor receives events for their own appointments', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctor.id, role: 'doctor' });
    const patientId = seedPatient(db, clinicId);

    const doctorSession = await loginAs(app, doctor);
    const conn = await connectSse({ server, path: '/api/appointments/events', cookie: doctorSession.cookie });

    const created = await request(app)
      .post('/api/appointments')
      .set('Cookie', doctorSession.cookie)
      .set('X-CSRF-Token', doctorSession.csrfToken)
      .send({ patient_id: patientId, doctor_id: doctor.id, starts_at: '2030-01-10T14:00:00Z', ends_at: '2030-01-10T14:30:00Z' });
    assert.equal(created.status, 201);

    const event = await conn.waitFor((e) => e.type === 'appointment.created');
    assert.equal(event.data.doctor_id, doctor.id);
    conn.close();
  } finally {
    await cleanup();
  }
});

test("a doctor does not receive events for another doctor's appointments", async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctorA = seedUser(db, { password: 'correct-password' });
    const doctorB = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctorA.id, role: 'doctor' });
    seedMembership(db, { clinicId, userId: doctorB.id, role: 'doctor' });
    const secretary = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: secretary.id, role: 'secretary' });
    const patientId = seedPatient(db, clinicId);

    const sessionA = await loginAs(app, doctorA);
    const connA = await connectSse({ server, path: '/api/appointments/events', cookie: sessionA.cookie });

    const secretarySession = await loginAs(app, secretary);
    const created = await request(app)
      .post('/api/appointments')
      .set('Cookie', secretarySession.cookie)
      .set('X-CSRF-Token', secretarySession.csrfToken)
      .send({ patient_id: patientId, doctor_id: doctorB.id, starts_at: '2030-01-10T14:00:00Z', ends_at: '2030-01-10T14:30:00Z' });
    assert.equal(created.status, 201);

    await wait(150);
    assert.equal(connA.events.length, 0, 'doctor A should not see doctor B appointments');
    connA.close();
  } finally {
    await cleanup();
  }
});

test('a nurse without a verifiable assignment never receives appointment events', async () => {
  // Mismo resultado que "rejects a user without appointments:read
  // permission": nurse no tiene appointments:read en esta fase (sin
  // modelo de asignación verificable, ver requirePermission.js), así que
  // ni siquiera puede abrir el canal SSE.
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const nurse = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: nurse.id, role: 'nurse' });
    const { cookie } = await loginAs(app, nurse);

    const conn = await connectSse({ server, path: '/api/appointments/events', cookie });
    assert.equal(conn.statusCode, 403);
  } finally {
    await cleanup();
  }
});

test('an admin alone has no operative access to appointment events', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const admin = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: admin.id, role: 'admin' });
    const { cookie } = await loginAs(app, admin);

    const conn = await connectSse({ server, path: '/api/appointments/events', cookie });
    assert.equal(conn.statusCode, 403);
  } finally {
    await cleanup();
  }
});

test('closes the connection when the user switches to a different authorized clinic', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicA = seedClinic(db, 'Clinic A');
    const clinicB = seedClinic(db, 'Clinic B');
    const secretary = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId: clinicA, userId: secretary.id, role: 'secretary' });
    seedMembership(db, { clinicId: clinicB, userId: secretary.id, role: 'secretary' });

    const session = await loginAs(app, secretary);
    // La conexión queda "anclada" al consultorio A, el consultorio activo
    // en el momento en que se abrió.
    const conn = await connectSse({ server, path: '/api/appointments/events', cookie: session.cookie });

    const switched = await request(app)
      .post('/api/auth/clinic')
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrfToken)
      .send({ clinic_id: clinicB });
    assert.equal(switched.status, 200);

    // El próximo heartbeat revalida la sesión: activeClinicId ya es B,
    // pero esta conexión se abrió para A, así que se cierra.
    await conn.waitForClose(1000);
  } finally {
    await cleanup();
  }
});

test('closes the SSE connection shortly after the user logs out', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctor.id, role: 'doctor' });

    const session = await loginAs(app, doctor);
    const conn = await connectSse({ server, path: '/api/appointments/events', cookie: session.cookie });

    const logout = await request(app).post('/api/auth/logout').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrfToken);
    assert.equal(logout.status, 204);

    // El heartbeat (cada FAST_HEARTBEAT_MS) revalida la sesión y cierra la
    // conexión al no encontrarla ya en la tabla `sessions`.
    await conn.waitForClose(1000);
  } finally {
    await cleanup();
  }
});

test('closes the SSE connection shortly after the session expires', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctor.id, role: 'doctor' });

    const session = await loginAs(app, doctor);
    const conn = await connectSse({ server, path: '/api/appointments/events', cookie: session.cookie });

    db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1000);

    await conn.waitForClose(1000);
  } finally {
    await cleanup();
  }
});

test('cleans up the subscriber and releases the connection slot on client disconnect', async () => {
  const { db, app, server, broker, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctor.id, role: 'doctor' });
    const { cookie } = await loginAs(app, doctor);

    const conn = await connectSse({ server, path: '/api/appointments/events', cookie });
    await wait(30);
    assert.equal(broker.subscriberCount, 1);

    conn.close();
    await wait(100);
    assert.equal(broker.subscriberCount, 0);
  } finally {
    await cleanup();
  }
});

test('sends periodic heartbeat comments to keep the connection alive', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctor.id, role: 'doctor' });
    const { cookie } = await loginAs(app, doctor);

    const conn = await connectSse({ server, path: '/api/appointments/events', cookie });
    await wait(FAST_HEARTBEAT_MS * 3);

    const heartbeatCount = (conn.rawBody.match(/: heartbeat/g) || []).length;
    assert.ok(heartbeatCount >= 1, `expected at least one heartbeat, saw: ${conn.rawBody}`);
    conn.close();
  } finally {
    await cleanup();
  }
});

test('closes every open connection on an orderly broker shutdown', async () => {
  const { db, app, server, broker, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctor.id, role: 'doctor' });
    const { cookie } = await loginAs(app, doctor);

    const conn = await connectSse({ server, path: '/api/appointments/events', cookie });
    await wait(30);
    assert.equal(broker.subscriberCount, 1);

    broker.closeAll();

    await conn.waitForClose(1000);
    assert.equal(broker.subscriberCount, 0);
  } finally {
    await cleanup();
  }
});

test('fans out events correctly to multiple concurrent connections without cross-talk', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctorA = seedUser(db, { password: 'correct-password' });
    const doctorB = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctorA.id, role: 'doctor' });
    seedMembership(db, { clinicId, userId: doctorB.id, role: 'doctor' });
    const secretary = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: secretary.id, role: 'secretary' });
    const patientId = seedPatient(db, clinicId);

    const sessionA = await loginAs(app, doctorA);
    const sessionB = await loginAs(app, doctorB);
    const [connA, connB] = await Promise.all([
      connectSse({ server, path: '/api/appointments/events', cookie: sessionA.cookie }),
      connectSse({ server, path: '/api/appointments/events', cookie: sessionB.cookie }),
    ]);

    const secretarySession = await loginAs(app, secretary);
    const createdA = await request(app)
      .post('/api/appointments')
      .set('Cookie', secretarySession.cookie)
      .set('X-CSRF-Token', secretarySession.csrfToken)
      .send({ patient_id: patientId, doctor_id: doctorA.id, starts_at: '2030-01-10T14:00:00Z', ends_at: '2030-01-10T14:30:00Z' });
    const createdB = await request(app)
      .post('/api/appointments')
      .set('Cookie', secretarySession.cookie)
      .set('X-CSRF-Token', secretarySession.csrfToken)
      .send({ patient_id: patientId, doctor_id: doctorB.id, starts_at: '2030-01-10T15:00:00Z', ends_at: '2030-01-10T15:30:00Z' });
    assert.equal(createdA.status, 201);
    assert.equal(createdB.status, 201);

    const eventA = await connA.waitFor((e) => e.type === 'appointment.created');
    const eventB = await connB.waitFor((e) => e.type === 'appointment.created');
    assert.equal(eventA.data.doctor_id, doctorA.id);
    assert.equal(eventB.data.doctor_id, doctorB.id);

    await wait(100);
    assert.equal(connA.events.filter((e) => e.type === 'appointment.created').length, 1);
    assert.equal(connB.events.filter((e) => e.type === 'appointment.created').length, 1);

    connA.close();
    connB.close();
  } finally {
    await cleanup();
  }
});

test('never includes patient names/emails or other sensitive fields in event payloads', async () => {
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const { session, createAppointment } = await setupClinicWithSecretary(db, app);
    const conn = await connectSse({ server, path: '/api/appointments/events', cookie: session.cookie });

    await createAppointment();

    const event = await conn.waitFor((e) => e.type === 'appointment.created');
    const keys = Object.keys(event.data).sort();
    assert.deepEqual(keys, ['appointment_id', 'doctor_id', 'occurred_at', 'patient_id', 'status']);
    conn.close();
  } finally {
    await cleanup();
  }
});

test('an appointment cannot be reassigned to a different doctor (doctor_id is immutable), so there is no cross-schedule leak to guard against', async () => {
  // El enunciado de Fase 6 pide no filtrar información entre agendas si
  // una cita "cambia de médico". En este sistema eso no puede ocurrir:
  // PATCH /api/appointments/:id rechaza doctor_id como campo desconocido
  // (ver appointments.schema.js, sin cambios en esta fase) — reasignar
  // una cita a otro médico simplemente no es una operación soportada.
  const { db, app, server, cleanup } = createIsolatedApp();
  try {
    const { session, createAppointment, doctor } = await setupClinicWithSecretary(db, app);
    const created = await createAppointment();

    const res = await request(app)
      .patch(`/api/appointments/${created.id}`)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrfToken)
      .send({ doctor_id: doctor.id + 1 });

    assert.equal(res.status, 400);
  } finally {
    await cleanup();
  }
});
