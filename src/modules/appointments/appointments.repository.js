'use strict';

// Única capa que conoce SQL. Todas las consultas están parametrizadas y
// siempre filtran por clinic_id para aislar los datos entre consultorios.

const UPDATABLE_COLUMNS = ['starts_at', 'ends_at', 'status'];

function findAppointmentById(db, { id, clinicId }) {
  return db.prepare('SELECT * FROM appointments WHERE id = ? AND clinic_id = ?').get(id, clinicId);
}

// Médico activo con rol 'doctor' en ese consultorio. No basta con que el
// id exista en users: debe tener membresía 'doctor' en clinic_id y active=1.
function findActiveDoctorInClinic(db, { id, clinicId }) {
  return db
    .prepare(
      `SELECT users.* FROM users
       JOIN clinic_memberships ON clinic_memberships.user_id = users.id
       WHERE users.id = ?
         AND clinic_memberships.clinic_id = ?
         AND clinic_memberships.role = 'doctor'
         AND users.active = 1
       LIMIT 1`,
    )
    .get(id, clinicId);
}

// Médicos activos del consultorio (id + nombre únicamente). Fase 7: el
// formulario de citas del frontend necesita un selector de médico
// autorizado; no existía ningún endpoint para listar usuarios de un
// consultorio, así que se agrega esta única consulta de solo lectura en
// vez de inventar datos en el cliente (ver appointments.controller.js /
// GET /api/appointments/doctors).
function listDoctorsInClinic(db, { clinicId }) {
  return db
    .prepare(
      `SELECT users.id AS id, users.name AS name
       FROM users
       JOIN clinic_memberships ON clinic_memberships.user_id = users.id
       WHERE clinic_memberships.clinic_id = ?
         AND clinic_memberships.role = 'doctor'
         AND users.active = 1
       ORDER BY users.name`,
    )
    .all(clinicId);
}

// true si el médico ya tiene otra cita activa (scheduled/confirmed) que se
// solapa con [startsAt, endsAt). excludeId permite ignorar la propia cita
// al reprogramar. Las citas completed/cancelled nunca bloquean horario.
function hasOverlap(db, { clinicId, doctorId, startsAt, endsAt, excludeId }) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM appointments
       WHERE clinic_id = ?
         AND doctor_id = ?
         AND status IN ('scheduled', 'confirmed')
         AND id != ?
         AND starts_at < ?
         AND ends_at > ?`,
    )
    .get(clinicId, doctorId, excludeId ?? -1, endsAt, startsAt);

  return row.count > 0;
}

function insertAppointment(db, { clinicId, patientId, doctorId, startsAt, endsAt }) {
  const result = db
    .prepare(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(clinicId, patientId, doctorId, startsAt, endsAt);

  return findAppointmentById(db, { id: result.lastInsertRowid, clinicId });
}

function updateAppointment(db, { id, clinicId, fields }) {
  const columns = Object.keys(fields).filter((key) => UPDATABLE_COLUMNS.includes(key));
  if (columns.length === 0) {
    return findAppointmentById(db, { id, clinicId });
  }

  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  const values = columns.map((column) => fields[column]);

  const result = db
    .prepare(`UPDATE appointments SET ${assignments} WHERE id = ? AND clinic_id = ?`)
    .run(...values, id, clinicId);

  if (result.changes === 0) {
    return undefined;
  }
  return findAppointmentById(db, { id, clinicId });
}

function buildListFilter({ clinicId, doctorId, patientId, status, from, to }) {
  const clauses = ['clinic_id = ?'];
  const params = [clinicId];

  if (doctorId) {
    clauses.push('doctor_id = ?');
    params.push(doctorId);
  }
  if (patientId) {
    clauses.push('patient_id = ?');
    params.push(patientId);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (from) {
    clauses.push('starts_at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('starts_at <= ?');
    params.push(to);
  }

  return { where: clauses.join(' AND '), params };
}

function countAppointments(db, filters) {
  const { where, params } = buildListFilter(filters);
  return db.prepare(`SELECT COUNT(*) AS count FROM appointments WHERE ${where}`).get(...params).count;
}

function listAppointments(db, { clinicId, doctorId, patientId, status, from, to, page, limit }) {
  const { where, params } = buildListFilter({ clinicId, doctorId, patientId, status, from, to });
  const offset = (page - 1) * limit;

  const rows = db
    .prepare(`SELECT * FROM appointments WHERE ${where} ORDER BY starts_at LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  const total = countAppointments(db, { clinicId, doctorId, patientId, status, from, to });
  return { rows, total };
}

module.exports = {
  findAppointmentById,
  findActiveDoctorInClinic,
  listDoctorsInClinic,
  hasOverlap,
  insertAppointment,
  updateAppointment,
  listAppointments,
  countAppointments,
};
