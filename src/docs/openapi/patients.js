'use strict';

/**
 * Documentación de /api/patients (ver src/modules/patients/*.js). Archivo
 * solo de anotaciones @openapi; no implementa ninguna ruta.
 *
 * Todas las operaciones exigen sesión + consultorio activo (o, en modo
 * DEMO local, el contexto inyectado para pruebas) y el permiso RBAC
 * indicado en cada operación; nunca se acepta clinic_id del cliente.
 *
 * @openapi
 * components:
 *   schemas:
 *     Patient:
 *       type: object
 *       properties:
 *         id: { type: integer, example: 1 }
 *         first_name: { type: string, example: Ana }
 *         last_name: { type: string, example: Ejemplo }
 *         phone: { type: string, nullable: true, example: '0991234567' }
 *         email: { type: string, nullable: true, format: email, example: ana@example.test }
 *         created_at: { type: string, format: date-time, example: '2026-11-01T20:45:20.890Z' }
 *       required: [id, first_name, last_name, created_at]
 *     PatientCreate:
 *       type: object
 *       properties:
 *         first_name: { type: string, minLength: 2, maxLength: 100, example: Ana }
 *         last_name: { type: string, minLength: 2, maxLength: 100, example: Ejemplo }
 *         phone:
 *           type: string
 *           minLength: 6
 *           maxLength: 20
 *           pattern: '^[+]?[0-9\s\-()]+$'
 *           description: Dígitos, espacios, guiones, paréntesis y un '+' inicial opcional.
 *           example: '0991234567'
 *         email: { type: string, format: email, example: ana@example.test }
 *       required: [first_name, last_name]
 *       additionalProperties: false
 *     PatientUpdate:
 *       type: object
 *       description: >
 *         Parcial: al menos un campo (objeto vacío -> 422). No admite id ni
 *         clinic_id (se rechazan como campos desconocidos -> 400).
 *       properties:
 *         first_name: { type: string, minLength: 2, maxLength: 100 }
 *         last_name: { type: string, minLength: 2, maxLength: 100 }
 *         phone: { type: string, minLength: 6, maxLength: 20 }
 *         email: { type: string, format: email }
 *       additionalProperties: false
 *     PatientList:
 *       type: object
 *       properties:
 *         patients: { type: array, items: { $ref: '#/components/schemas/Patient' } }
 *         page: { type: integer, example: 1 }
 *         limit: { type: integer, example: 20 }
 *         total: { type: integer, example: 1 }
 *         totalPages: { type: integer, example: 1 }
 *       required: [patients, page, limit, total, totalPages]
 *
 * /patients:
 *   post:
 *     tags: [Pacientes]
 *     summary: Registrar un paciente
 *     description: Requiere el permiso `patients:create` (doctor o secretary).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/PatientCreate' }
 *           examples:
 *             ficticio:
 *               summary: Paciente ficticio de ejemplo
 *               value: { first_name: Ana, last_name: Ejemplo, phone: '0991234567', email: ana@example.test }
 *     responses:
 *       '201':
 *         description: Paciente creado.
 *         content:
 *           application/json: { schema: { $ref: '#/components/schemas/Patient' } }
 *       '400': { description: Validación de entrada (campo inválido o desconocido)., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '401': { description: Sin sesión., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: 'Sin permiso patients:create, o CSRF faltante/inválido.', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   get:
 *     tags: [Pacientes]
 *     summary: Listar / buscar pacientes
 *     description: Requiere `patients:read`. Solo devuelve pacientes del consultorio autorizado.
 *     parameters:
 *       - { name: search, in: query, schema: { type: string, maxLength: 100 }, example: ana }
 *       - { name: page, in: query, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       '200':
 *         description: Página de resultados.
 *         content:
 *           application/json: { schema: { $ref: '#/components/schemas/PatientList' } }
 *       '401': { description: Sin sesión., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: Sin permiso `patients:read`., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *
 * /patients/{id}:
 *   parameters:
 *     - { name: id, in: path, required: true, schema: { type: integer, minimum: 1 } }
 *   get:
 *     tags: [Pacientes]
 *     summary: Consultar un paciente
 *     description: >
 *       404 si no existe **o pertenece a otro consultorio** (mismo mensaje
 *       en ambos casos, para no revelar datos ajenos).
 *     responses:
 *       '200': { description: Paciente encontrado., content: { application/json: { schema: { $ref: '#/components/schemas/Patient' } } } }
 *       '401': { description: Sin sesión., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: Sin permiso `patients:read`., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: No existe en el consultorio autorizado., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   patch:
 *     tags: [Pacientes]
 *     summary: Actualizar un paciente (parcial)
 *     description: Requiere `patients:update` (doctor o secretary).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/PatientUpdate' }
 *           examples:
 *             telefono: { summary: Solo cambia el teléfono, value: { phone: '0987654321' } }
 *     responses:
 *       '200': { description: Paciente actualizado., content: { application/json: { schema: { $ref: '#/components/schemas/Patient' } } } }
 *       '400': { description: Campo desconocido o inválido., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '401': { description: Sin sesión., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: 'Sin permiso, o CSRF inválido.', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: No existe en el consultorio autorizado., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '422': { description: Objeto vacío (ningún campo para actualizar)., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   delete:
 *     tags: [Pacientes]
 *     summary: Eliminar un paciente
 *     description: >
 *       Requiere `patients:delete` (solo secretary; doctor NO lo tiene por
 *       defecto). No se borra en cascada: si el paciente tiene citas
 *       registradas, se rechaza con 409.
 *     responses:
 *       '204': { description: Eliminado. }
 *       '401': { description: Sin sesión., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: 'Sin permiso patients:delete, o CSRF inválido.', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: No existe en el consultorio autorizado., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409':
 *         description: El paciente tiene citas registradas.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { status: error, message: Cannot delete a patient with appointments on record }
 */

module.exports = {};
