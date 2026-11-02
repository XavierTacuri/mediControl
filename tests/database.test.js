'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getDatabase, closeDatabase } = require('../src/db/database');

function tempDbPath() {
  return path.join(os.tmpdir(), `medicontrol-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
}

function cleanup(dbPath) {
  closeDatabase(dbPath);
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

function seedClinicWithDoctorAndPatient(db) {
  const clinicId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Consultorio Central').lastInsertRowid;
  const doctorId = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run('Dra. Ana Perez', 'ana.perez@example.com', 'hash')
    .lastInsertRowid;
  db.prepare('INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES (?, ?, ?)').run(
    clinicId,
    doctorId,
    'doctor',
  );
  const patientId = db
    .prepare('INSERT INTO patients (clinic_id, first_name, last_name) VALUES (?, ?, ?)')
    .run(clinicId, 'Juan', 'Torres')
    .lastInsertRowid;

  return { clinicId, doctorId, patientId };
}

test('initializes SQLite with WAL journal mode and busy timeout', () => {
  const dbPath = tempDbPath();
  try {
    const db = getDatabase(dbPath);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
  } finally {
    cleanup(dbPath);
  }
});

test('enables foreign key enforcement', () => {
  const dbPath = tempDbPath();
  try {
    const db = getDatabase(dbPath);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    cleanup(dbPath);
  }
});

test('creates all expected tables', () => {
  const dbPath = tempDbPath();
  try {
    const db = getDatabase(dbPath);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);

    for (const expected of ['clinics', 'users', 'clinic_memberships', 'patients', 'appointments']) {
      assert.ok(rows.includes(expected), `expected table ${expected} to exist`);
    }
  } finally {
    cleanup(dbPath);
  }
});

test('rejects clinic memberships with an invalid role', () => {
  const dbPath = tempDbPath();
  try {
    const db = getDatabase(dbPath);
    const clinicId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Consultorio').lastInsertRowid;
    const userId = db
      .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run('Luis Gomez', 'luis@example.com', 'hash')
      .lastInsertRowid;

    assert.throws(() => {
      db.prepare('INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES (?, ?, ?)').run(
        clinicId,
        userId,
        'superadmin',
      );
    }, /CHECK constraint failed/);
  } finally {
    cleanup(dbPath);
  }
});

test('allows a user to hold multiple roles in the same clinic', () => {
  const dbPath = tempDbPath();
  try {
    const db = getDatabase(dbPath);
    const clinicId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Consultorio').lastInsertRowid;
    const userId = db
      .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run('Maria Ruiz', 'maria@example.com', 'hash')
      .lastInsertRowid;

    db.prepare('INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES (?, ?, ?)').run(
      clinicId,
      userId,
      'doctor',
    );
    db.prepare('INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES (?, ?, ?)').run(
      clinicId,
      userId,
      'admin',
    );

    const count = db
      .prepare('SELECT COUNT(*) AS count FROM clinic_memberships WHERE user_id = ?')
      .get(userId).count;
    assert.equal(count, 2);
  } finally {
    cleanup(dbPath);
  }
});

test('rejects appointments with an invalid status', () => {
  const dbPath = tempDbPath();
  try {
    const db = getDatabase(dbPath);
    const { clinicId, doctorId, patientId } = seedClinicWithDoctorAndPatient(db);

    assert.throws(() => {
      db.prepare(
        'INSERT INTO appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at, status) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(clinicId, patientId, doctorId, '2026-11-02T10:00:00.000Z', '2026-11-02T10:30:00.000Z', 'pending');
    }, /CHECK constraint failed/);
  } finally {
    cleanup(dbPath);
  }
});

test('rejects an appointment whose patient belongs to a different clinic', () => {
  const dbPath = tempDbPath();
  try {
    const db = getDatabase(dbPath);
    const { doctorId: _unusedDoctor, patientId } = seedClinicWithDoctorAndPatient(db);
    const otherClinicId = db.prepare('INSERT INTO clinics (name) VALUES (?)').run('Otro Consultorio').lastInsertRowid;
    const otherDoctorId = db
      .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run('Dr. Otro', 'otro@example.com', 'hash')
      .lastInsertRowid;
    db.prepare('INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES (?, ?, ?)').run(
      otherClinicId,
      otherDoctorId,
      'doctor',
    );

    assert.throws(() => {
      db.prepare(
        'INSERT INTO appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)',
      ).run(otherClinicId, patientId, otherDoctorId, '2026-11-02T10:00:00.000Z', '2026-11-02T10:30:00.000Z');
    }, /patient does not belong to the appointment clinic/);
  } finally {
    cleanup(dbPath);
  }
});

test('rejects an appointment whose doctor does not hold the doctor role in the clinic', () => {
  const dbPath = tempDbPath();
  try {
    const db = getDatabase(dbPath);
    const { clinicId, patientId } = seedClinicWithDoctorAndPatient(db);
    const secretaryId = db
      .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run('Secretaria', 'secretaria@example.com', 'hash')
      .lastInsertRowid;
    db.prepare('INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES (?, ?, ?)').run(
      clinicId,
      secretaryId,
      'secretary',
    );

    assert.throws(() => {
      db.prepare(
        'INSERT INTO appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)',
      ).run(clinicId, patientId, secretaryId, '2026-11-02T10:00:00.000Z', '2026-11-02T10:30:00.000Z');
    }, /doctor does not belong to the clinic with role doctor/);
  } finally {
    cleanup(dbPath);
  }
});

test('rejects an appointment whose end time is not strictly after the start time', () => {
  const dbPath = tempDbPath();
  try {
    const db = getDatabase(dbPath);
    const { clinicId, doctorId, patientId } = seedClinicWithDoctorAndPatient(db);

    assert.throws(() => {
      db.prepare(
        'INSERT INTO appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)',
      ).run(clinicId, patientId, doctorId, '2026-11-02T10:00:00.000Z', '2026-11-02T10:00:00.000Z');
    }, /CHECK constraint failed/);
  } finally {
    cleanup(dbPath);
  }
});

test('accepts a well-formed appointment for a valid doctor and patient', () => {
  const dbPath = tempDbPath();
  try {
    const db = getDatabase(dbPath);
    const { clinicId, doctorId, patientId } = seedClinicWithDoctorAndPatient(db);

    const appointmentId = db
      .prepare(
        'INSERT INTO appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(clinicId, patientId, doctorId, '2026-11-02T10:00:00.000Z', '2026-11-02T10:30:00.000Z').lastInsertRowid;

    const row = db.prepare('SELECT status FROM appointments WHERE id = ?').get(appointmentId);
    assert.equal(row.status, 'scheduled');
  } finally {
    cleanup(dbPath);
  }
});
