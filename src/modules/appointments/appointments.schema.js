'use strict';

const { z } = require('zod');
const { APPOINTMENT_STATUSES } = require('../../db/schema');

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

// Exige un offset/'Z' explícito (sin ambigüedad de zona horaria) y se
// normaliza siempre a un instante UTC en el mismo formato que usa
// src/db/schema.js (YYYY-MM-DDTHH:MM:SS.sssZ).
const isoDateTime = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

const statusSchema = z.enum(APPOINTMENT_STATUSES);

const createAppointmentSchema = z
  .object({
    patient_id: z.coerce.number().int().positive(),
    doctor_id: z.coerce.number().int().positive(),
    starts_at: isoDateTime,
    ends_at: isoDateTime,
  })
  .strict()
  .refine((data) => data.ends_at > data.starts_at, {
    message: 'ends_at must be strictly after starts_at',
    path: ['ends_at'],
  });

// Sin refine de intervalo: una reprogramación parcial (solo starts_at o
// solo ends_at) es sintácticamente válida aquí. appointments.service.js
// combina el valor nuevo con el existente antes de validar el intervalo
// completo y el solapamiento (ver sección "Reprogramar cita" en el README).
const updateAppointmentSchema = z
  .object({
    starts_at: isoDateTime.optional(),
    ends_at: isoDateTime.optional(),
    status: statusSchema.optional(),
  })
  .strict();

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const listQuerySchema = z
  .object({
    doctor_id: z.coerce.number().int().positive().optional(),
    patient_id: z.coerce.number().int().positive().optional(),
    status: statusSchema.optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    page: z.coerce.number().int().min(1).optional().default(DEFAULT_PAGE),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional().default(DEFAULT_PAGE_LIMIT),
  })
  .refine((data) => !data.from || !data.to || data.from <= data.to, {
    message: 'from must be before or equal to to',
    path: ['from'],
  });

module.exports = {
  createAppointmentSchema,
  updateAppointmentSchema,
  idParamSchema,
  listQuerySchema,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
};
