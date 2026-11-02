'use strict';

/**
 * MediControl — Esquema de base de datos (Fase 2).
 *
 * Alcance de esta fase: pacientes y citas médicas únicamente.
 * No se implementan historias clínicas, recetas, signos vitales,
 * facturación ni autenticación real (ver README.md).
 *
 * Fechas: todas las columnas *_at almacenan instantes en UTC con
 * formato ISO 8601 (YYYY-MM-DDTHH:MM:SS.sssZ). La zona horaria del
 * consultorio (IANA, p.ej. "America/Guayaquil") se añadirá en una
 * fase posterior junto con la configuración de CLINICS; por ahora
 * toda la aplicación asume que el cliente convierte a la zona local.
 *
 * Reglas pendientes para fases posteriores (NO implementadas aquí):
 *   - Prevención real de solapamiento de citas por médico. La regla
 *     (nueva_inicio < existente_fin Y nueva_fin > existente_inicio,
 *     considerando solo status IN ('scheduled','confirmed')) se
 *     documenta y se preparan índices, pero la validación debe
 *     hacerse de forma transaccional en la capa de servicio del
 *     módulo de citas, porque SQLite no puede expresar una
 *     restricción de solapamiento entre filas mediante CHECK/trigger
 *     simple sin condiciones de carrera entre conexiones.
 *   - Validación de formato de teléfono/email de pacientes.
 *   - Soft-delete / auditoría de cambios.
 *   - Zona horaria por consultorio.
 *
 * Cambio de Fase 3: appointments.patient_id pasó de ON DELETE CASCADE a
 * ON DELETE RESTRICT. Con CASCADE, borrar un paciente borraba en silencio
 * sus citas; el módulo de pacientes (src/modules/patients) exige impedir
 * ese borrado mientras existan citas asociadas (409 Conflict), así que la
 * base de datos debe rechazarlo también como segunda barrera, igual que
 * ya se hacía con doctor_id. Al usar CREATE TABLE IF NOT EXISTS, una base
 * de datos creada con el esquema anterior conserva el CASCADE original;
 * en esta fase (datos ficticios, sin migraciones todavía) basta con
 * recrear el archivo .db local para adoptar la nueva restricción.
 *
 * Estrategia de integridad para doctor_id:
 *   Una FK a users(id) no basta: no garantiza que el usuario
 *   pertenezca al mismo consultorio ni que tenga el rol "doctor".
 *   SQLite no permite subconsultas a otras tablas dentro de un
 *   CHECK, así que esa regla se aplica con triggers BEFORE
 *   INSERT/UPDATE que verifican, contra clinic_memberships, que
 *   doctor_id pertenece a clinic_id con role = 'doctor'. Lo mismo
 *   se aplica para garantizar que el paciente de la cita pertenezca
 *   al mismo consultorio que la cita.
 */

const ROLES = Object.freeze(['admin', 'doctor', 'secretary', 'nurse']);

const APPOINTMENT_STATUSES = Object.freeze([
  'scheduled',
  'confirmed',
  'completed',
  'cancelled',
]);

// Estados que deben considerarse al detectar solapamientos (fase futura).
const ACTIVE_APPOINTMENT_STATUSES = Object.freeze(['scheduled', 'confirmed']);

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS clinics (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
    email         TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(trim(email)) > 0),
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS clinic_memberships (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    clinic_id  INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('admin', 'doctor', 'secretary', 'nurse')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (clinic_id, user_id, role)
  );

  CREATE INDEX IF NOT EXISTS idx_memberships_clinic ON clinic_memberships(clinic_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_user ON clinic_memberships(user_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_clinic_role ON clinic_memberships(clinic_id, role);

  CREATE TABLE IF NOT EXISTS patients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    clinic_id  INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    first_name TEXT NOT NULL CHECK (length(trim(first_name)) > 0),
    last_name  TEXT NOT NULL CHECK (length(trim(last_name)) > 0),
    phone      TEXT,
    email      TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_id);

  CREATE TABLE IF NOT EXISTS appointments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    clinic_id  INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
    doctor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    starts_at  TEXT NOT NULL,
    ends_at    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (ends_at > starts_at)
  );

  CREATE INDEX IF NOT EXISTS idx_appointments_clinic ON appointments(clinic_id);
  CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);
  CREATE INDEX IF NOT EXISTS idx_appointments_doctor ON appointments(doctor_id);

  -- Preparado para la detección de solapamientos (fase de agendamiento):
  -- acelera "WHERE doctor_id = ? AND status IN ('scheduled','confirmed')
  -- AND starts_at < ? AND ends_at > ?".
  CREATE INDEX IF NOT EXISTS idx_appointments_doctor_active
    ON appointments(doctor_id, starts_at, ends_at)
    WHERE status IN ('scheduled', 'confirmed');

  -- El paciente de la cita debe pertenecer al mismo consultorio que la cita.
  CREATE TRIGGER IF NOT EXISTS trg_appointments_patient_clinic_insert
  BEFORE INSERT ON appointments
  BEGIN
    SELECT RAISE(ABORT, 'patient does not belong to the appointment clinic')
    WHERE (SELECT clinic_id FROM patients WHERE id = NEW.patient_id) IS NOT NEW.clinic_id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_appointments_patient_clinic_update
  BEFORE UPDATE ON appointments
  BEGIN
    SELECT RAISE(ABORT, 'patient does not belong to the appointment clinic')
    WHERE (SELECT clinic_id FROM patients WHERE id = NEW.patient_id) IS NOT NEW.clinic_id;
  END;

  -- El médico debe pertenecer al consultorio con el rol 'doctor'.
  CREATE TRIGGER IF NOT EXISTS trg_appointments_doctor_role_insert
  BEFORE INSERT ON appointments
  BEGIN
    SELECT RAISE(ABORT, 'doctor does not belong to the clinic with role doctor')
    WHERE NOT EXISTS (
      SELECT 1 FROM clinic_memberships
      WHERE clinic_id = NEW.clinic_id AND user_id = NEW.doctor_id AND role = 'doctor'
    );
  END;

  CREATE TRIGGER IF NOT EXISTS trg_appointments_doctor_role_update
  BEFORE UPDATE ON appointments
  BEGIN
    SELECT RAISE(ABORT, 'doctor does not belong to the clinic with role doctor')
    WHERE NOT EXISTS (
      SELECT 1 FROM clinic_memberships
      WHERE clinic_id = NEW.clinic_id AND user_id = NEW.doctor_id AND role = 'doctor'
    );
  END;

  -- Fase 5: almacén de sesiones HTTP (express-session), ver
  -- src/middlewares/sqliteSessionStore.js. expires_at es un epoch en
  -- milisegundos; una sesión con expires_at en el pasado se trata como
  -- inexistente (sesión expirada) y se borra al leerla.
  CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`;

function createSchema(db) {
  db.exec(SCHEMA_SQL);
}

module.exports = {
  createSchema,
  ROLES,
  APPOINTMENT_STATUSES,
  ACTIVE_APPOINTMENT_STATUSES,
};
