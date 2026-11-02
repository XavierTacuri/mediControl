'use strict';

const repository = require('./appointments.repository');
const patientsRepository = require('../patients/patients.repository');

class NotFoundError extends Error {
  constructor(message = 'Appointment not found') {
    super(message);
    this.status = 404;
  }
}

class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.status = 403;
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

// Máquina de estados (ver README, sección "Reprogramar cita"). completed y
// cancelled son terminales: no admiten ninguna transición de salida.
const TRANSITIONS = Object.freeze({
  scheduled: Object.freeze(['confirmed', 'cancelled']),
  confirmed: Object.freeze(['completed', 'cancelled']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

// Alcance por recurso (Fase 5, sección 7): un usuario cuyo único rol
// clínico en este consultorio es 'doctor' solo puede ver/crear/gestionar
// SUS PROPIAS citas (doctor_id === context.userId). 'secretary' (y por lo
// tanto un "médico independiente" que también tenga ese rol) gestiona la
// agenda completa del consultorio. 'admin' NO amplía este alcance por sí
// solo (no otorga acceso clínico, ver requirePermission.js); el contexto
// DEMO tiene 'secretary' en su lista de roles, así que nunca queda
// restringido (ver demoContext.js).
function hasClinicWideScheduling(context) {
  return context.roles.includes('secretary');
}

function assertPatientBelongsToClinic(db, { patientId, clinicId }) {
  const patient = patientsRepository.findPatientById(db, { id: patientId, clinicId });
  if (!patient) {
    throw new UnprocessableEntityError('patient_id does not reference a patient in this clinic');
  }
}

function assertDoctorBelongsToClinic(db, { doctorId, clinicId }) {
  const doctor = repository.findActiveDoctorInClinic(db, { id: doctorId, clinicId });
  if (!doctor) {
    throw new UnprocessableEntityError(
      'doctor_id does not reference an active doctor with the doctor role in this clinic',
    );
  }
}

function assertNotInThePast(startsAt, clock) {
  if (new Date(startsAt).getTime() < clock.now().getTime()) {
    throw new UnprocessableEntityError('Appointments cannot be scheduled in the past');
  }
}

function assertCanActOnDoctor(context, doctorId) {
  if (!hasClinicWideScheduling(context) && doctorId !== context.userId) {
    throw new ForbiddenError('A doctor can only manage their own appointments');
  }
}

// Publica un evento SOLO después de que la transacción SQLite ya confirmó
// el cambio (ver createAppointment/updateAppointment/cancelAppointment:
// esta función se llama siempre DESPUÉS de que `.immediate()` retorna, no
// dentro de la transacción) y solo cuando representa un cambio real — un
// `broker` ausente (p. ej. código que llama al servicio sin pasar por
// HTTP) no debe romper nada, por eso se tolera `undefined`.
function publishAppointmentEvent(broker, clinicId, type, appointment, clock) {
  if (!broker) return;
  const now = clock ? clock.now() : new Date();
  broker.publish(clinicId, {
    type,
    data: {
      appointment_id: appointment.id,
      patient_id: appointment.patient_id,
      doctor_id: appointment.doctor_id,
      status: appointment.status,
      occurred_at: now.toISOString(),
    },
  });
}

// Comprobación de disponibilidad + inserción dentro de una misma
// transacción con BEGIN IMMEDIATE: adquiere el bloqueo de escritura antes
// de leer, para que ninguna otra conexión pueda insertar una cita que
// solape entre la comprobación y la escritura (evita la condición de
// carrera "check-then-act"). busy_timeout (src/db/database.js) hace que
// una segunda conexión que choque con el bloqueo espere en vez de fallar
// de inmediato.
function createAppointment(db, { context, data, clock, broker }) {
  const { clinicId } = context;
  const patientId = data.patient_id;
  const doctorId = data.doctor_id;
  const { starts_at: startsAt, ends_at: endsAt } = data;

  assertPatientBelongsToClinic(db, { patientId, clinicId });
  assertDoctorBelongsToClinic(db, { doctorId, clinicId });
  assertCanActOnDoctor(context, doctorId);
  assertNotInThePast(startsAt, clock);

  const createInTransaction = db.transaction(() => {
    if (repository.hasOverlap(db, { clinicId, doctorId, startsAt, endsAt })) {
      throw new ConflictError('The doctor already has an appointment that overlaps this time slot');
    }
    return repository.insertAppointment(db, { clinicId, patientId, doctorId, startsAt, endsAt });
  });

  // Si .immediate() lanza (conflicto de solapamiento, violación de un
  // trigger, etc.), SQLite deshace la transacción y esta línea nunca se
  // alcanza: no se publica ningún evento por una operación fallida.
  const appointment = createInTransaction.immediate();
  publishAppointmentEvent(broker, clinicId, 'appointment.created', appointment, clock);
  return appointment;
}

function listAppointments(db, { context, query }) {
  const { clinicId } = context;
  const { patient_id: patientId, status, from, to, page, limit } = query;

  // Un médico "puro" (sin secretary) siempre ve su propia agenda,
  // ignorando cualquier doctor_id recibido por query: nunca se filtra por
  // la agenda de otro médico, se seleccione lo que se seleccione.
  const doctorId = hasClinicWideScheduling(context) ? query.doctor_id : context.userId;

  const { rows, total } = repository.listAppointments(db, {
    clinicId,
    doctorId,
    patientId,
    status,
    from,
    to,
    page,
    limit,
  });
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  return { items: rows, page, limit, total, totalPages };
}

// No distingue "no existe" de "pertenece a otro consultorio": ambos casos
// filtran por clinic_id y responden el mismo 404 (ver patients.service.js
// para la misma convención). El acceso entre médicos del MISMO consultorio
// sí se distingue (403, ver assertCanActOnDoctor): el recurso existe y es
// de este consultorio, solo que este usuario no tiene alcance sobre él.
function getAppointmentById(db, { context, id }) {
  const appointment = repository.findAppointmentById(db, { id, clinicId: context.clinicId });
  if (!appointment) {
    throw new NotFoundError();
  }
  assertCanActOnDoctor(context, appointment.doctor_id);
  return appointment;
}

function updateAppointment(db, { context, id, data, clock, broker }) {
  const { clinicId } = context;

  if (Object.keys(data).length === 0) {
    throw new UnprocessableEntityError('At least one field must be provided to update an appointment');
  }

  const existing = repository.findAppointmentById(db, { id, clinicId });
  if (!existing) {
    throw new NotFoundError();
  }
  assertCanActOnDoctor(context, existing.doctor_id);

  // completed y cancelled son terminales: ninguna modificación está
  // permitida, ni de horario ni de estado.
  if (existing.status === 'completed' || existing.status === 'cancelled') {
    throw new ConflictError(`Cannot modify an appointment with status '${existing.status}'`);
  }

  const fields = {};

  if (data.status !== undefined && data.status !== existing.status) {
    const allowedNextStatuses = TRANSITIONS[existing.status];
    if (!allowedNextStatuses.includes(data.status)) {
      throw new ConflictError(`Invalid status transition from '${existing.status}' to '${data.status}'`);
    }
    fields.status = data.status;
  }

  const isRescheduling = data.starts_at !== undefined || data.ends_at !== undefined;
  const nextStartsAt = data.starts_at ?? existing.starts_at;
  const nextEndsAt = data.ends_at ?? existing.ends_at;

  if (isRescheduling) {
    // Se valida el intervalo COMPLETO resultante, no solo el campo
    // enviado: una reprogramación parcial (solo starts_at, por ejemplo)
    // igual debe producir starts_at < ends_at.
    if (!(nextEndsAt > nextStartsAt)) {
      throw new UnprocessableEntityError('ends_at must be strictly after starts_at');
    }
    // Corrección de la Fase 4: crear una cita en el pasado ya se rechazaba,
    // pero reprogramar una cita existente hacia el pasado no se revalidaba.
    // Solo se comprueba cuando el horario realmente cambia: un cambio de
    // status (confirmar/cancelar) sobre una cita cuya hora ya pasó con el
    // tiempo no debe bloquearse por esto.
    assertNotInThePast(nextStartsAt, clock);
    fields.starts_at = nextStartsAt;
    fields.ends_at = nextEndsAt;
  }

  const updateInTransaction = db.transaction(() => {
    if (
      isRescheduling &&
      repository.hasOverlap(db, {
        clinicId,
        doctorId: existing.doctor_id,
        startsAt: nextStartsAt,
        endsAt: nextEndsAt,
        excludeId: id,
      })
    ) {
      throw new ConflictError('The doctor already has an appointment that overlaps this time slot');
    }
    return repository.updateAppointment(db, { id, clinicId, fields });
  });

  const appointment = updateInTransaction.immediate();

  // Solo se publica si `fields` tenía algo que escribir realmente: un
  // PATCH que no cambia nada (p. ej. status igual al actual, sin
  // reprogramar) no debe generar un evento duplicado/fantasma.
  if (Object.keys(fields).length > 0) {
    const type =
      fields.status === 'cancelled'
        ? 'appointment.cancelled'
        : fields.status === 'completed'
          ? 'appointment.completed'
          : 'appointment.updated';
    publishAppointmentEvent(broker, clinicId, type, appointment, clock);
  }

  return appointment;
}

// DELETE es una cancelación lógica (nunca se borra la fila). Es idempotente:
// cancelar una cita ya cancelada responde éxito sin volver a escribir.
function cancelAppointment(db, { context, id, clock, broker }) {
  const { clinicId } = context;
  const existing = repository.findAppointmentById(db, { id, clinicId });
  if (!existing) {
    throw new NotFoundError();
  }
  assertCanActOnDoctor(context, existing.doctor_id);

  // Idempotente: ya estaba cancelada, no hay cambio real -> no se publica
  // ningún evento (evita duplicados en operaciones idempotentes).
  if (existing.status === 'cancelled') {
    return existing;
  }
  if (existing.status === 'completed') {
    throw new ConflictError('Cannot cancel a completed appointment');
  }

  const appointment = repository.updateAppointment(db, { id, clinicId, fields: { status: 'cancelled' } });
  publishAppointmentEvent(broker, clinicId, 'appointment.cancelled', appointment, clock);
  return appointment;
}

module.exports = {
  createAppointment,
  listAppointments,
  getAppointmentById,
  updateAppointment,
  cancelAppointment,
  TRANSITIONS,
  hasClinicWideScheduling,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  UnprocessableEntityError,
};
