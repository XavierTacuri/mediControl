'use strict';

const repository = require('./patients.repository');

class NotFoundError extends Error {
  constructor(message = 'Patient not found') {
    super(message);
    this.status = 404;
  }
}

class ConflictError extends Error {
  constructor(message = 'Conflict') {
    super(message);
    this.status = 409;
  }
}

class UnprocessableEntityError extends Error {
  constructor(message = 'Unprocessable entity') {
    super(message);
    this.status = 422;
  }
}

function createPatient(db, { clinicId, data }) {
  return repository.insertPatient(db, { clinicId, ...data });
}

function listPatients(db, { clinicId, query }) {
  const { search, page, limit } = query;
  const { rows, total } = repository.listPatients(db, { clinicId, search, page, limit });
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  return { items: rows, page, limit, total, totalPages };
}

// No distingue entre "no existe" y "pertenece a otro consultorio": ambos
// casos filtran por clinic_id y responden el mismo 404, para no revelar
// la existencia de registros de otros consultorios.
function getPatientById(db, { clinicId, id }) {
  const patient = repository.findPatientById(db, { id, clinicId });
  if (!patient) {
    throw new NotFoundError();
  }
  return patient;
}

function updatePatient(db, { clinicId, id, data }) {
  if (Object.keys(data).length === 0) {
    throw new UnprocessableEntityError('At least one field must be provided to update a patient');
  }

  const existing = repository.findPatientById(db, { id, clinicId });
  if (!existing) {
    throw new NotFoundError();
  }

  return repository.updatePatient(db, { id, clinicId, fields: data });
}

function deletePatient(db, { clinicId, id }) {
  const existing = repository.findPatientById(db, { id, clinicId });
  if (!existing) {
    throw new NotFoundError();
  }

  const appointmentsCount = repository.countAppointmentsForPatient(db, { id, clinicId });
  if (appointmentsCount > 0) {
    throw new ConflictError('Cannot delete a patient with appointments on record');
  }

  repository.deletePatient(db, { id, clinicId });
}

module.exports = {
  createPatient,
  listPatients,
  getPatientById,
  updatePatient,
  deletePatient,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
};
