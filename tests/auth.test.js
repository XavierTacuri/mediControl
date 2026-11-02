'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');
const { LoginRateLimiter } = require('../src/modules/auth/auth.service');
const { seedClinic, seedUser, seedMembership } = require('./helpers/authSeed');

function createMutableClock(initial) {
  let current = initial;
  return {
    now: () => current,
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

// demoMode:false siempre en este archivo: estas pruebas verifican la
// autenticación REAL (sesión + CSRF), no el atajo de inyección de
// contexto para pruebas de negocio (ver patients.test.js/appointments.test.js).
function createIsolatedApp(overrides = {}) {
  const dbPath = ':memory:';
  const db = getDatabase(dbPath);
  const clock = overrides.clock || { now: () => new Date() };
  const loginRateLimiter = overrides.loginRateLimiter || new LoginRateLimiter({ clock });
  const app = createApp({ db, demoMode: false, clock, loginRateLimiter, ...overrides });
  return { app, db, cleanup: () => closeDatabase(dbPath) };
}

test('logs in with valid credentials and never returns the password hash', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const doctor = seedUser(db, { name: 'Dra. Ana', password: 'super-secret-1' });
    seedMembership(db, { clinicId, userId: doctor.id, role: 'doctor' });

    const res = await request(app).post('/api/auth/login').send({ email: doctor.email, password: doctor.password });

    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, doctor.email);
    assert.equal(res.body.user.password_hash, undefined);
    assert.equal(res.body.activeClinicId, clinicId);
    assert.ok(res.body.csrfToken);
    assert.ok(res.headers['set-cookie'].some((cookie) => cookie.startsWith('medicontrol.sid=')));
  } finally {
    cleanup();
  }
});

test('rejects an incorrect password with a generic message', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const doctor = seedUser(db, { password: 'correct-password' });

    const res = await request(app).post('/api/auth/login').send({ email: doctor.email, password: 'wrong-password' });

    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Invalid email or password');
  } finally {
    cleanup();
  }
});

test('rejects a non-existent user with the same generic message', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.test', password: 'whatever-123' });

    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Invalid email or password');
  } finally {
    cleanup();
  }
});

test('rejects a deactivated user with the same generic message', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const inactiveUser = seedUser(db, { password: 'correct-password', active: 0 });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: inactiveUser.email, password: inactiveUser.password });

    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Invalid email or password');
  } finally {
    cleanup();
  }
});

test('login never leaks whether the account exists (wrong password vs unknown vs inactive)', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const activeUser = seedUser(db, { password: 'correct-password' });
    const inactiveUser = seedUser(db, { password: 'correct-password', active: 0 });

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: activeUser.email, password: 'nope' });
    const unknownUser = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody-else@example.test', password: 'nope' });
    const inactive = await request(app)
      .post('/api/auth/login')
      .send({ email: inactiveUser.email, password: inactiveUser.password });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.equal(inactive.status, 401);
    assert.equal(wrongPassword.body.message, unknownUser.body.message);
    assert.equal(wrongPassword.body.message, inactive.body.message);
  } finally {
    cleanup();
  }
});

test('logs out and invalidates the session', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const user = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: user.id, role: 'doctor' });

    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ email: user.email, password: user.password });
    const csrfToken = login.body.csrfToken;

    const logout = await agent.post('/api/auth/logout').set('X-CSRF-Token', csrfToken);
    assert.equal(logout.status, 204);

    const me = await agent.get('/api/auth/me');
    assert.equal(me.status, 401);
  } finally {
    cleanup();
  }
});

test('treats an expired session as logged out', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const user = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: user.id, role: 'doctor' });

    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: user.email, password: user.password });

    const before = await agent.get('/api/auth/me');
    assert.equal(before.status, 200);

    // Simula el vencimiento de la sesión (ver src/middlewares/sqliteSessionStore.js):
    // se trata como si no existiera.
    db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1000);

    const after = await agent.get('/api/auth/me');
    assert.equal(after.status, 401);
  } finally {
    cleanup();
  }
});

test('regenerates the session id on every login (prevents session fixation)', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const user = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: user.id, role: 'doctor' });

    const agent = request.agent(app);
    const first = await agent.post('/api/auth/login').send({ email: user.email, password: user.password });
    await agent.post('/api/auth/logout').set('X-CSRF-Token', first.body.csrfToken);
    const second = await agent.post('/api/auth/login').send({ email: user.email, password: user.password });

    const sidOf = (res) => res.headers['set-cookie'].find((c) => c.startsWith('medicontrol.sid='));
    assert.notEqual(sidOf(first), sidOf(second));
  } finally {
    cleanup();
  }
});

test('GET /api/auth/me returns the authenticated profile and rejects when unauthenticated', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const user = seedUser(db, { name: 'Dra. Ana', password: 'correct-password' });
    seedMembership(db, { clinicId, userId: user.id, role: 'doctor' });

    const anonymous = await request(app).get('/api/auth/me');
    assert.equal(anonymous.status, 401);

    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ email: user.email, password: user.password });
    const me = await agent.get('/api/auth/me');

    assert.equal(me.status, 200);
    assert.equal(me.body.user.name, 'Dra. Ana');
    assert.equal(me.body.clinics.length, 1);
    assert.equal(me.body.clinics[0].roles[0], 'doctor');
    // El frontend (Fase 7) recupera el token CSRF aquí tras un refresh de
    // página, ya que nunca lo persiste del lado del cliente.
    assert.equal(me.body.csrfToken, login.body.csrfToken);
  } finally {
    cleanup();
  }
});

test('rejects protected routes without authentication (401)', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const res = await request(app).get('/api/patients');
    assert.equal(res.status, 401);
  } finally {
    cleanup();
  }
});

test('rejects an authenticated user with no permission for the operation (403)', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const nurse = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: nurse.id, role: 'nurse' });

    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: nurse.email, password: nurse.password });

    const res = await agent.get('/api/patients');
    assert.equal(res.status, 403);
  } finally {
    cleanup();
  }
});

test('rejects a mutating request without the CSRF token', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const secretary = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: secretary.id, role: 'secretary' });

    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: secretary.email, password: secretary.password });

    const withoutToken = await agent.post('/api/patients').send({ first_name: 'Ana', last_name: 'Ejemplo' });
    assert.equal(withoutToken.status, 403);
  } finally {
    cleanup();
  }
});

test('accepts a mutating request with a valid CSRF token', async () => {
  const { db, app, cleanup } = createIsolatedApp();
  try {
    const clinicId = seedClinic(db, 'Clinic A');
    const secretary = seedUser(db, { password: 'correct-password' });
    seedMembership(db, { clinicId, userId: secretary.id, role: 'secretary' });

    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ email: secretary.email, password: secretary.password });

    const res = await agent
      .post('/api/patients')
      .set('X-CSRF-Token', login.body.csrfToken)
      .send({ first_name: 'Ana', last_name: 'Ejemplo' });

    assert.equal(res.status, 201);
  } finally {
    cleanup();
  }
});

test('treats a garbled/invalid session cookie as unauthenticated', async () => {
  const { app, cleanup } = createIsolatedApp();
  try {
    const res = await request(app).get('/api/auth/me').set('Cookie', 'medicontrol.sid=not-a-real-session-id');
    assert.equal(res.status, 401);
  } finally {
    cleanup();
  }
});

test('locks out login after too many failed attempts, until the lockout window elapses', async () => {
  const clock = createMutableClock(new Date('2026-06-15T12:00:00.000Z'));
  const loginRateLimiter = new LoginRateLimiter({ clock, maxAttempts: 3, lockoutMs: 60_000 });
  const { db, app, cleanup } = createIsolatedApp({ clock, loginRateLimiter });
  try {
    const user = seedUser(db, { password: 'correct-password' });

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/api/auth/login').send({ email: user.email, password: 'wrong' });
      assert.equal(res.status, 401);
    }

    // La 4a vez, incluso con la contraseña CORRECTA, debe quedar bloqueada.
    const lockedOut = await request(app).post('/api/auth/login').send({ email: user.email, password: user.password });
    assert.equal(lockedOut.status, 429);

    clock.advance(61_000);

    const afterLockout = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password });
    assert.equal(afterLockout.status, 200);
  } finally {
    cleanup();
  }
});
