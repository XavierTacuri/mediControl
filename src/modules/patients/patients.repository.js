'use strict';

// Única capa que conoce SQL. Todas las consultas están parametrizadas y
// siempre filtran por clinic_id para aislar los datos entre consultorios.

const UPDATABLE_COLUMNS = ['first_name', 'last_name', 'phone', 'email'];

function findPatientById(db, { id, clinicId }) {
  return db.prepare('SELECT * FROM patients WHERE id = ? AND clinic_id = ?').get(id, clinicId);
}

function insertPatient(db, { clinicId, first_name, last_name, phone, email }) {
  const result = db
    .prepare(
      `INSERT INTO patients (clinic_id, first_name, last_name, phone, email)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(clinicId, first_name, last_name, phone ?? null, email ?? null);

  return findPatientById(db, { id: result.lastInsertRowid, clinicId });
}

function countPatients(db, { clinicId, search }) {
  if (search) {
    const pattern = `%${search}%`;
    return db
      .prepare(
        `SELECT COUNT(*) AS count FROM patients
         WHERE clinic_id = ? AND (first_name LIKE ? COLLATE NOCASE OR last_name LIKE ? COLLATE NOCASE)`,
      )
      .get(clinicId, pattern, pattern).count;
  }
  return db.prepare('SELECT COUNT(*) AS count FROM patients WHERE clinic_id = ?').get(clinicId).count;
}

function listPatients(db, { clinicId, search, page, limit }) {
  const offset = (page - 1) * limit;
  let rows;

  if (search) {
    const pattern = `%${search}%`;
    rows = db
      .prepare(
        `SELECT * FROM patients
         WHERE clinic_id = ? AND (first_name LIKE ? COLLATE NOCASE OR last_name LIKE ? COLLATE NOCASE)
         ORDER BY id
         LIMIT ? OFFSET ?`,
      )
      .all(clinicId, pattern, pattern, limit, offset);
  } else {
    rows = db
      .prepare('SELECT * FROM patients WHERE clinic_id = ? ORDER BY id LIMIT ? OFFSET ?')
      .all(clinicId, limit, offset);
  }

  const total = countPatients(db, { clinicId, search });
  return { rows, total };
}

function updatePatient(db, { id, clinicId, fields }) {
  const columns = Object.keys(fields).filter((key) => UPDATABLE_COLUMNS.includes(key));
  if (columns.length === 0) {
    return findPatientById(db, { id, clinicId });
  }

  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  const values = columns.map((column) => fields[column]);

  const result = db
    .prepare(`UPDATE patients SET ${assignments} WHERE id = ? AND clinic_id = ?`)
    .run(...values, id, clinicId);

  if (result.changes === 0) {
    return undefined;
  }
  return findPatientById(db, { id, clinicId });
}

function countAppointmentsForPatient(db, { id, clinicId }) {
  return db
    .prepare('SELECT COUNT(*) AS count FROM appointments WHERE patient_id = ? AND clinic_id = ?')
    .get(id, clinicId).count;
}

function deletePatient(db, { id, clinicId }) {
  const result = db.prepare('DELETE FROM patients WHERE id = ? AND clinic_id = ?').run(id, clinicId);
  return result.changes > 0;
}

module.exports = {
  findPatientById,
  insertPatient,
  countPatients,
  listPatients,
  updatePatient,
  countAppointmentsForPatient,
  deletePatient,
};
