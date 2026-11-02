'use strict';

const { z } = require('zod');

const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    password: z.string().min(1).max(200),
  })
  .strict();

const selectClinicSchema = z
  .object({
    clinic_id: z.coerce.number().int().positive(),
  })
  .strict();

module.exports = { loginSchema, selectClinicSchema };
