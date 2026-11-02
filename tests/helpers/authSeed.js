'use strict';

const bcrypt = require('bcryptjs');

let emailCounter = 0;
function uniqueEmail(prefix) {
  emailCounter += 1;
  return `${prefix}-${emailCounter}@example.test`;
}

function seedClinic(db, name) {
  return db.prepare('INSERT INTO clinics (name) VALUES (?)').run(name).lastInsertRowid;
}

// password en texto plano SOLO existe en memoria del proceso de pruebas;
// se guarda siempre como hash bcrypt, igual que en producción.
function seedUser(db, { name = 'Test User', email, password = 'correct-password', active = 1 } = {}) {
  const resolvedEmail = email || uniqueEmail('user');
  const passwordHash = bcrypt.hashSync(password, 10);
  const id = db
    .prepare('INSERT INTO users (name, email, password_hash, active) VALUES (?, ?, ?, ?)')
    .run(name, resolvedEmail, passwordHash, active).lastInsertRowid;
  return { id, email: resolvedEmail, password };
}

function seedMembership(db, { clinicId, userId, role }) {
  db.prepare('INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES (?, ?, ?)').run(
    clinicId,
    userId,
    role,
  );
}

function seedPatient(db, clinicId, { firstName = 'Paciente', lastName = 'Demo' } = {}) {
  return db
    .prepare('INSERT INTO patients (clinic_id, first_name, last_name) VALUES (?, ?, ?)')
    .run(clinicId, firstName, lastName).lastInsertRowid;
}

module.exports = { uniqueEmail, seedClinic, seedUser, seedMembership, seedPatient };
