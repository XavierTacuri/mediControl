'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');
const { seedClinic, seedUser, seedMembership, seedPatient } = require('./helpers/authSeed');

function createIsolatedApp(overrides = {}) {
  const dbPath = ':memory:';
  const db = getDatabase(dbPath);
  const app = createApp({ db, demoMode: false, ...overrides });
  return { app, db, cleanup: () => closeDatabase(dbPath) };
}

async function loginAs(app, user) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email: user.email, password: user.password });
  assert.equal(res.status, 200, `login as ${user.email} should succeed`);
  return { agent, csrfToken: res.body.csrfToken, body: res.body };
}

test('a doctor can create and list their own appointments', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctor.id, role: 'doctor' });
    const patientId = seedPatient(db, clinicId);

    const { agent, csrfToken } = await loginAs(app, doctor);

    const created = await agent
      .post('/api/appointments')
      .set('X-CSRF-Token', csrfToken)
      .send({
        patient_id: patientId,
        doctor_id: doctor.id,
        starts_at: '2030-01-10T14:00:00Z',
        ends_at: '2030-01-10T14:30:00Z',
      });
    assert.equal(created.status, 201);

    const list = await agent.get('/api/appointments');
    assert.equal(list.status, 200);
    assert.equal(list.body.appointments.length, 1);
    assert.equal(list.body.appointments[0].doctor_id, doctor.id);
  } finally {
    cleanup();
  }
});

test('a plain doctor cannot read, reschedule, or cancel another doctor\'s appointments', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctorA = seedUser(db, { password: 'correct-password' });
    const doctorB = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctorA.id, role: 'doctor' });
    seedMembership(db, { clinicId, userId: doctorB.id, role: 'doctor' });
    const patientId = seedPatient(db, clinicId);

    const { agent: agentA, csrfToken: csrfA } = await loginAs(app, doctorA);
    const created = await agentA
      .post('/api/appointments')
      .set('X-CSRF-Token', csrfA)
      .send({
        patient_id: patientId,
        doctor_id: doctorA.id,
        starts_at: '2030-01-10T14:00:00Z',
        ends_at: '2030-01-10T14:30:00Z',
      });
    assert.equal(created.status, 201);

    const { agent: agentB, csrfToken: csrfB } = await loginAs(app, doctorB);

    const get = await agentB.get(`/api/appointments/${created.body.id}`);
    assert.equal(get.status, 403);

    const patch = await agentB
      .patch(`/api/appointments/${created.body.id}`)
      .set('X-CSRF-Token', csrfB)
      .send({ status: 'confirmed' });
    assert.equal(patch.status, 403);

    const cancel = await agentB.delete(`/api/appointments/${created.body.id}`).set('X-CSRF-Token', csrfB);
    assert.equal(cancel.status, 403);

    // doctorB tampoco puede crear una cita asignándosela a doctorA.
    const createForOther = await agentB
      .post('/api/appointments')
      .set('X-CSRF-Token', csrfB)
      .send({
        patient_id: patientId,
        doctor_id: doctorA.id,
        starts_at: '2030-02-10T14:00:00Z',
        ends_at: '2030-02-10T14:30:00Z',
      });
    assert.equal(createForOther.status, 403);
  } finally {
    cleanup();
  }
});

test('a secretary manages appointments for any doctor in the clinic', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctor = seedUser(db, { password: 'correct-password' });
    const secretary = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: doctor.id, role: 'doctor' });
    seedMembership(db, { clinicId, userId: secretary.id, role: 'secretary' });
    const patientId = seedPatient(db, clinicId);

    const { agent, csrfToken } = await loginAs(app, secretary);

    const created = await agent
      .post('/api/appointments')
      .set('X-CSRF-Token', csrfToken)
      .send({
        patient_id: patientId,
        doctor_id: doctor.id,
        starts_at: '2030-01-10T14:00:00Z',
        ends_at: '2030-01-10T14:30:00Z',
      });
    assert.equal(created.status, 201);

    const confirmed = await agent
      .patch(`/api/appointments/${created.body.id}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ status: 'confirmed' });
    assert.equal(confirmed.status, 200);

    const list = await agent.get('/api/appointments');
    assert.equal(list.body.appointments.length, 1);
  } finally {
    cleanup();
  }
});

test('a nurse has no access to patients or appointments in this phase', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const nurse = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: nurse.id, role: 'nurse' });

    const { agent } = await loginAs(app, nurse);

    const patients = await agent.get('/api/patients');
    assert.equal(patients.status, 403);

    const appointments = await agent.get('/api/appointments');
    assert.equal(appointments.status, 403);
  } finally {
    cleanup();
  }
});

test('an admin alone does not gain clinical access automatically', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const admin = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: admin.id, role: 'admin' });

    const { agent } = await loginAs(app, admin);

    const patients = await agent.get('/api/patients');
    assert.equal(patients.status, 403);
  } finally {
    cleanup();
  }
});

test('a user with multiple roles gets the union of their permissions', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const user = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: user.id, role: 'doctor' });
    seedMembership(db, { clinicId, userId: user.id, role: 'secretary' });
    const patientId = seedPatient(db, clinicId);

    const { agent, csrfToken } = await loginAs(app, user);

    // patients:delete solo lo otorga 'secretary' en la matriz de permisos;
    // este usuario lo tiene por tener ese rol además de 'doctor'.
    const del = await agent.delete(`/api/patients/${patientId}`).set('X-CSRF-Token', csrfToken);
    assert.equal(del.status, 204);
  } finally {
    cleanup();
  }
});

test('an independent doctor (admin+doctor+secretary) gets full clinical access and auto-selects their single clinic', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Consultorio Independiente');
    const independentDoctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: independentDoctor.id, role: 'admin' });
    seedMembership(db, { clinicId, userId: independentDoctor.id, role: 'doctor' });
    seedMembership(db, { clinicId, userId: independentDoctor.id, role: 'secretary' });
    const patientId = seedPatient(db, clinicId);

    const { agent, csrfToken, body } = await loginAs(app, independentDoctor);

    // Un único consultorio -> se auto-selecciona al iniciar sesión, sin
    // necesidad de llamar a POST /api/auth/clinic.
    assert.equal(body.activeClinicId, clinicId);

    const created = await agent
      .post('/api/appointments')
      .set('X-CSRF-Token', csrfToken)
      .send({
        patient_id: patientId,
        doctor_id: independentDoctor.id,
        starts_at: '2030-01-10T14:00:00Z',
        ends_at: '2030-01-10T14:30:00Z',
      });
    assert.equal(created.status, 201);
  } finally {
    cleanup();
  }
});

test('switching to an authorized clinic updates the active context', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicA = seedClinic(db, 'Clinic A');
    const clinicB = seedClinic(db, 'Clinic B');
    const doctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId: clinicA, userId: doctor.id, role: 'doctor' });
    seedMembership(db, { clinicId: clinicB, userId: doctor.id, role: 'doctor' });

    const { agent, csrfToken, body } = await loginAs(app, doctor);
    // Dos consultorios -> no se auto-selecciona ninguno.
    assert.equal(body.activeClinicId, null);

    const noClinic = await agent.get('/api/appointments');
    assert.equal(noClinic.status, 403);

    const select = await agent.post('/api/auth/clinic').set('X-CSRF-Token', csrfToken).send({ clinic_id: clinicB });
    assert.equal(select.status, 200);
    assert.equal(select.body.activeClinicId, clinicB);

    const afterSelect = await agent.get('/api/appointments');
    assert.equal(afterSelect.status, 200);
  } finally {
    cleanup();
  }
});

test('rejects switching to a clinic the user is not a member of', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicA = seedClinic(db, 'Clinic A');
    const otherClinic = seedClinic(db, 'Other Clinic');
    const doctor = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId: clinicA, userId: doctor.id, role: 'doctor' });

    const { agent, csrfToken } = await loginAs(app, doctor);

    const select = await agent
      .post('/api/auth/clinic')
      .set('X-CSRF-Token', csrfToken)
      .send({ clinic_id: otherClinic });
    assert.equal(select.status, 403);
  } finally {
    cleanup();
  }
});

test('patients are fully isolated between clinics even with real sessions', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicA = seedClinic(db, 'Clinic A');
    const clinicB = seedClinic(db, 'Clinic B');
    const doctorA = seedUser(db, { password: 'correct-password' });
    const doctorB = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId: clinicA, userId: doctorA.id, role: 'doctor' });
    seedMembership(db, { clinicId: clinicB, userId: doctorB.id, role: 'doctor' });

    const { agent: agentA, csrfToken: csrfA } = await loginAs(app, doctorA);
    const created = await agentA
      .post('/api/patients')
      .set('X-CSRF-Token', csrfA)
      .send({ first_name: 'Ana', last_name: 'Ejemplo' });
    assert.equal(created.status, 201);

    const { agent: agentB } = await loginAs(app, doctorB);
    const fromB = await agentB.get(`/api/patients/${created.body.id}`);
    assert.equal(fromB.status, 404);

    const listFromB = await agentB.get('/api/patients');
    assert.equal(listFromB.body.total, 0);
  } finally {
    cleanup();
  }
});
