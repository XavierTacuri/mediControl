'use strict';

/**
 * Crea perfiles de usuario ficticios para probar manualmente la Fase 5
 * (login + RBAC) en un entorno LOCAL. Nunca se ejecuta automáticamente:
 * hay que invocarlo a mano con `npm run seed:demo`.
 *
 * Seguridad:
 *   - Se niega a correr si NODE_ENV=production.
 *   - La contraseña NO está escrita en el código: se lee de la variable
 *     de entorno DEMO_USERS_PASSWORD (definida en tu .env local, nunca en
 *     git) y se guarda siempre como hash bcrypt.
 *   - Es idempotente: si un usuario con ese email ya existe, se reutiliza
 *     en vez de duplicarlo (puedes ejecutarlo varias veces sin problema).
 */

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { loadConfig } = require('../src/config/env');
const { getDatabase, closeDatabase } = require('../src/db/database');

const config = loadConfig();

if (config.isProduction) {
  console.error('Refusing to seed demo users with NODE_ENV=production.');
  process.exit(1);
}

const password = process.env.DEMO_USERS_PASSWORD;
if (!password) {
  console.error('Set DEMO_USERS_PASSWORD in your local .env before running this script.');
  process.exit(1);
}

const db = getDatabase(config.DATABASE_PATH);
const passwordHash = bcrypt.hashSync(password, 10);

function upsertClinic(name) {
  const existing = db.prepare('SELECT id FROM clinics WHERE name = ?').get(name);
  if (existing) {
    console.log(`Reutilizando consultorio existente "${name}" (id ${existing.id}).`);
    return existing.id;
  }
  return db.prepare('INSERT INTO clinics (name) VALUES (?)').run(name).lastInsertRowid;
}

// Idempotente: si el email ya existe, se reutiliza el usuario sin tocar
// su contraseña (nunca se sobrescribe sin necesidad). Si además su nombre
// no coincide con el esperado, se informa en vez de renombrarlo en
// silencio — puede ser una cuenta real con ese correo, no un duplicado.
function upsertUser(name, email) {
  const existing = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
  if (existing) {
    if (existing.name !== name) {
      console.warn(
        `Aviso: ya existe un usuario con ${email} pero con nombre "${existing.name}" (se esperaba "${name}"). Se reutiliza sin modificarlo.`,
      );
    } else {
      console.log(`Reutilizando usuario existente ${email} (id ${existing.id}); contraseña sin modificar.`);
    }
    return existing.id;
  }
  return db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name, email, passwordHash).lastInsertRowid;
}

function ensureMembership(clinicId, userId, role) {
  db.prepare(
    'INSERT OR IGNORE INTO clinic_memberships (clinic_id, user_id, role) VALUES (?, ?, ?)',
  ).run(clinicId, userId, role);
}

// Perfil 1: médico independiente (admin + doctor + secretary en su propio
// consultorio) — ver Fase 5, sección 8.
const independentClinicId = upsertClinic('Consultorio Médico Demo');
const independentDoctorId = upsertUser('Médico de Prueba', 'medico.independiente@example.test');
ensureMembership(independentClinicId, independentDoctorId, 'admin');
ensureMembership(independentClinicId, independentDoctorId, 'doctor');
ensureMembership(independentClinicId, independentDoctorId, 'secretary');

// Perfil 2 y 3: consultorio compartido con secretaria y enfermera.
const sharedClinicId = upsertClinic('Consultorio Compartido (DEMO)');
const sharedDoctorId = upsertUser('Dra. Demo', 'doctora.demo@example.test');
ensureMembership(sharedClinicId, sharedDoctorId, 'doctor');

const secretaryId = upsertUser('Secretaria Demo', 'secretaria.demo@example.test');
ensureMembership(sharedClinicId, secretaryId, 'secretary');

const nurseId = upsertUser('Enfermera Demo', 'enfermera.demo@example.test');
ensureMembership(sharedClinicId, nurseId, 'nurse');

// Perfil 4: administrador puro (sin acceso clínico automático).
const adminId = upsertUser('Administrador Demo', 'admin.demo@example.test');
ensureMembership(sharedClinicId, adminId, 'admin');

console.log('Demo users ready (all share the password from DEMO_USERS_PASSWORD):');
console.log('  medico.independiente@example.test  -> admin+doctor+secretary en', independentClinicId);
console.log('  doctora.demo@example.test          -> doctor en', sharedClinicId);
console.log('  secretaria.demo@example.test        -> secretary en', sharedClinicId);
console.log('  enfermera.demo@example.test         -> nurse en', sharedClinicId);
console.log('  admin.demo@example.test             -> admin en', sharedClinicId);

closeDatabase(config.DATABASE_PATH);
