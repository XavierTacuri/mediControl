'use strict';

const service = require('./appointments.service');
const repository = require('./appointments.repository');
const {
  createAppointmentSchema,
  updateAppointmentSchema,
  idParamSchema,
  listQuerySchema,
} = require('./appointments.schema');

// Errores de validación de ENTRADA (forma/tipo) -> 400, distintos de los
// errores de negocio (404/409/422) que lanza appointments.service.js.
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

function serializeAppointment(appointment) {
  return {
    id: appointment.id,
    patient_id: appointment.patient_id,
    doctor_id: appointment.doctor_id,
    starts_at: appointment.starts_at,
    ends_at: appointment.ends_at,
    status: appointment.status,
    created_at: appointment.created_at,
  };
}

// GET /api/appointments/doctors — médicos autorizados del consultorio
// activo (solo id + nombre), para el selector del formulario de citas del
// frontend. Mismo nivel de acceso que leer la agenda: no expone nada que
// un usuario con appointments:read no pudiera ya inferir creando/listando
// citas.
function listDoctors(req, res, next) {
  try {
    const db = req.app.get('db');
    const doctors = repository.listDoctorsInClinic(db, { clinicId: req.context.clinicId });
    res.status(200).json({ doctors });
  } catch (err) {
    next(err);
  }
}

function createAppointment(req, res, next) {
  try {
    const data = parse(createAppointmentSchema, req.body);
    const db = req.app.get('db');
    const clock = req.app.get('clock');
    const broker = req.app.get('appointmentBroker');
    const appointment = service.createAppointment(db, { context: req.context, data, clock, broker });
    res.status(201).json(serializeAppointment(appointment));
  } catch (err) {
    next(err);
  }
}

function listAppointments(req, res, next) {
  try {
    const query = parse(listQuerySchema, req.query);
    const db = req.app.get('db');
    const result = service.listAppointments(db, { context: req.context, query });
    res.status(200).json({
      appointments: result.items.map(serializeAppointment),
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    });
  } catch (err) {
    next(err);
  }
}

function getAppointment(req, res, next) {
  try {
    const { id } = parse(idParamSchema, req.params);
    const db = req.app.get('db');
    const appointment = service.getAppointmentById(db, { context: req.context, id });
    res.status(200).json(serializeAppointment(appointment));
  } catch (err) {
    next(err);
  }
}

function updateAppointment(req, res, next) {
  try {
    const { id } = parse(idParamSchema, req.params);
    const data = parse(updateAppointmentSchema, req.body);
    const db = req.app.get('db');
    const clock = req.app.get('clock');
    const broker = req.app.get('appointmentBroker');
    const appointment = service.updateAppointment(db, { context: req.context, id, data, clock, broker });
    res.status(200).json(serializeAppointment(appointment));
  } catch (err) {
    next(err);
  }
}

function cancelAppointment(req, res, next) {
  try {
    const { id } = parse(idParamSchema, req.params);
    const db = req.app.get('db');
    const clock = req.app.get('clock');
    const broker = req.app.get('appointmentBroker');
    service.cancelAppointment(db, { context: req.context, id, clock, broker });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listDoctors,
  createAppointment,
  listAppointments,
  getAppointment,
  updateAppointment,
  cancelAppointment,
};
