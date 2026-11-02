'use strict';

const service = require('./patients.service');
const { createPatientSchema, updatePatientSchema, idParamSchema, listQuerySchema } = require('./patients.schema');

// Errores de validación de ENTRADA (forma/tipo) -> 400, distintos de los
// errores de negocio (404/409/422) que lanza patients.service.js.
function toValidationError(zodError) {
  const err = new Error('Request validation failed');
  err.status = 400;
  err.details = zodError.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  return err;
}

function parse(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw toValidationError(result.error);
  }
  return result.data;
}

function serializePatient(patient) {
  return {
    id: patient.id,
    first_name: patient.first_name,
    last_name: patient.last_name,
    phone: patient.phone,
    email: patient.email,
    created_at: patient.created_at,
  };
}

function createPatient(req, res, next) {
  try {
    const data = parse(createPatientSchema, req.body);
    const db = req.app.get('db');
    const patient = service.createPatient(db, { clinicId: req.context.clinicId, data });
    res.status(201).json(serializePatient(patient));
  } catch (err) {
    next(err);
  }
}

function listPatients(req, res, next) {
  try {
    const query = parse(listQuerySchema, req.query);
    const db = req.app.get('db');
    const result = service.listPatients(db, { clinicId: req.context.clinicId, query });
    res.status(200).json({
      patients: result.items.map(serializePatient),
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    });
  } catch (err) {
    next(err);
  }
}

function getPatient(req, res, next) {
  try {
    const { id } = parse(idParamSchema, req.params);
    const db = req.app.get('db');
    const patient = service.getPatientById(db, { clinicId: req.context.clinicId, id });
    res.status(200).json(serializePatient(patient));
  } catch (err) {
    next(err);
  }
}

function updatePatient(req, res, next) {
  try {
    const { id } = parse(idParamSchema, req.params);
    const data = parse(updatePatientSchema, req.body);
    const db = req.app.get('db');
    const patient = service.updatePatient(db, { clinicId: req.context.clinicId, id, data });
    res.status(200).json(serializePatient(patient));
  } catch (err) {
    next(err);
  }
}

function deletePatient(req, res, next) {
  try {
    const { id } = parse(idParamSchema, req.params);
    const db = req.app.get('db');
    service.deletePatient(db, { clinicId: req.context.clinicId, id });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { createPatient, listPatients, getPatient, updatePatient, deletePatient };
