'use strict';

const { z } = require('zod');

const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 100;
const MIN_PHONE_LENGTH = 6;
const MAX_PHONE_LENGTH = 20;
const PHONE_PATTERN = /^[+]?[0-9\s\-()]+$/;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

const firstNameSchema = z.string().trim().min(MIN_NAME_LENGTH).max(MAX_NAME_LENGTH);
const lastNameSchema = z.string().trim().min(MIN_NAME_LENGTH).max(MAX_NAME_LENGTH);

// Acepta dígitos, espacios, guiones, paréntesis y un '+' inicial
// (formatos habituales de prefijo internacional), p.ej. "+593 99 123 4567".
const phoneSchema = z
  .string()
  .trim()
  .min(MIN_PHONE_LENGTH)
  .max(MAX_PHONE_LENGTH)
  .regex(PHONE_PATTERN, 'phone must contain only digits, spaces, hyphens, parentheses and an optional leading +');

// Se normaliza a minúsculas para evitar duplicados por diferencias de mayúsculas.
const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

const createPatientSchema = z
  .object({
    first_name: firstNameSchema,
    last_name: lastNameSchema,
    phone: phoneSchema.optional(),
    email: emailSchema.optional(),
  })
  .strict();

// Sin .refine(): un objeto vacío es sintácticamente válido aquí; la regla de
// negocio "al menos un campo" se evalúa en el servicio y responde 422
// (semántico) en lugar de 400 (estructural), ver patients.service.js.
const updatePatientSchema = z
  .object({
    first_name: firstNameSchema.optional(),
    last_name: lastNameSchema.optional(),
    phone: phoneSchema.optional(),
    email: emailSchema.optional(),
  })
  .strict();

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const listQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(MAX_NAME_LENGTH)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  page: z.coerce.number().int().min(1).optional().default(DEFAULT_PAGE),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional().default(DEFAULT_PAGE_LIMIT),
});

module.exports = {
  createPatientSchema,
  updatePatientSchema,
  idParamSchema,
  listQuerySchema,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
};
