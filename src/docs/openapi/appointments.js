'use strict';

/**
 * Documentación de /api/appointments (ver src/modules/appointments/*.js).
 * Archivo solo de anotaciones @openapi; no implementa ninguna ruta.
 *
 * @openapi
 * components:
 *   schemas:
 *     AppointmentStatus:
 *       type: string
 *       enum: [scheduled, confirmed, completed, cancelled]
 *     Appointment:
 *       type: object
 *       properties:
 *         id: { type: integer, example: 1 }
 *         patient_id: { type: integer, example: 1 }
 *         doctor_id: { type: integer, example: 1 }
 *         starts_at: { type: string, format: date-time, example: '2030-01-10T14:00:00.000Z' }
 *         ends_at: { type: string, format: date-time, example: '2030-01-10T14:30:00.000Z' }
 *         status: { $ref: '#/components/schemas/AppointmentStatus' }
 *         created_at: { type: string, format: date-time, example: '2026-11-01T21:05:49.804Z' }
 *       required: [id, patient_id, doctor_id, starts_at, ends_at, status, created_at]
 *     AppointmentCreate:
 *       type: object
 *       description: >
 *         clinic_id nunca se acepta aquí (se resuelve del lado del
 *         servidor). starts_at/ends_at deben ser ISO 8601 con zona horaria
 *         explícita (Z o ±HH:MM); se normalizan a UTC.
 *       properties:
 *         patient_id: { type: integer, minimum: 1, example: 1 }
 *         doctor_id: { type: integer, minimum: 1, example: 1 }
 *         starts_at: { type: string, format: date-time, example: '2030-01-10T14:00:00Z' }
 *         ends_at: { type: string, format: date-time, example: '2030-01-10T14:30:00Z' }
 *       required: [patient_id, doctor_id, starts_at, ends_at]
 *       additionalProperties: false
 *     AppointmentUpdate:
 *       type: object
 *       description: >
 *         Parcial: objeto vacío -> 422. No admite patient_id/doctor_id (son
 *         inmutables tras crear la cita; se rechazan como campo
 *         desconocido -> 400).
 *       properties:
 *         starts_at: { type: string, format: date-time }
 *         ends_at: { type: string, format: date-time }
 *         status: { $ref: '#/components/schemas/AppointmentStatus' }
 *       additionalProperties: false
 *     AppointmentList:
 *       type: object
 *       properties:
 *         appointments: { type: array, items: { $ref: '#/components/schemas/Appointment' } }
 *         page: { type: integer, example: 1 }
 *         limit: { type: integer, example: 20 }
 *         total: { type: integer, example: 1 }
 *         totalPages: { type: integer, example: 1 }
 *       required: [appointments, page, limit, total, totalPages]
 *     Doctor:
 *       type: object
 *       properties:
 *         id: { type: integer, example: 1 }
 *         name: { type: string, example: 'Dra. Ana Pérez' }
 *       required: [id, name]
 *     AppointmentEvent:
 *       type: object
 *       description: >
 *         Payload de cada mensaje SSE (campo `data`). Deliberadamente
 *         mínimo: nunca incluye nombre/correo del paciente, diagnósticos
 *         ni ningún dato clínico.
 *       properties:
 *         appointment_id: { type: integer, example: 1 }
 *         patient_id: { type: integer, example: 1 }
 *         doctor_id: { type: integer, example: 1 }
 *         status: { $ref: '#/components/schemas/AppointmentStatus' }
 *         occurred_at: { type: string, format: date-time, example: '2026-11-01T21:45:37.771Z' }
 *       required: [appointment_id, patient_id, doctor_id, status, occurred_at]
 *
 * /appointments/doctors:
 *   get:
 *     tags: [Citas]
 *     summary: Médicos autorizados del consultorio activo
 *     description: >
 *       Para el selector de médico al agendar una cita. Requiere
 *       `appointments:read`; solo devuelve médicos activos del
 *       consultorio autorizado, nunca de otro.
 *     responses:
 *       '200':
 *         description: Lista de médicos.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { doctors: { type: array, items: { $ref: '#/components/schemas/Doctor' } } }
 *       '401': { description: Sin sesión., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: Sin permiso `appointments:read`., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *
 * /appointments/events:
 *   get:
 *     tags: [Eventos en tiempo real]
 *     summary: Canal de notificaciones de citas (Server-Sent Events)
 *     description: >
 *       **Stream persistente, no una respuesta JSON de una sola vez.**
 *       Scalar puede abrir la conexión y mostrar las cabeceras, pero una
 *       UI de "Try it" pensada para peticiones request/response no
 *       renderiza bien un flujo que nunca termina — para ver los eventos
 *       llegar de verdad usa `curl -N` o un `EventSource` real (ver
 *       README, sección "Documentación interactiva (Scalar)"). Requiere
 *       `appointments:read`; un médico sin rol `secretary` solo recibe
 *       eventos de sus propias citas. Emite un comentario `: connected`
 *       al abrir y un comentario `: heartbeat` periódico; los eventos de
 *       negocio llegan como bloques `event: <tipo>` + `data: <JSON>`.
 *     responses:
 *       '200':
 *         description: Conexión SSE abierta (permanece abierta indefinidamente).
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               example: |-
 *                 event: appointment.created
 *                 data: {"appointment_id":1,"patient_id":1,"doctor_id":1,"status":"scheduled","occurred_at":"2026-11-01T21:45:37.771Z"}
 *         headers:
 *           Cache-Control: { schema: { type: string, example: 'no-cache, no-transform' } }
 *       '401': { description: Sin sesión., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: Sin permiso `appointments:read`., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '429': { description: Demasiadas conexiones SSE concurrentes para este usuario (límite de 3)., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *
 * /appointments:
 *   post:
 *     tags: [Citas]
 *     summary: Agendar una cita
 *     description: >
 *       Requiere `appointments:create`. Valida, en orden: formato de
 *       fechas e intervalo (400); paciente del consultorio (422); médico
 *       activo con rol doctor en el consultorio (422); si quien llama es
 *       un médico "puro", que doctor_id sea él mismo (403); que
 *       starts_at no sea pasado (422); y que el médico no tenga ya otra
 *       cita activa que se solape (409).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AppointmentCreate' }
 *           examples:
 *             demostracion:
 *               summary: Cita ficticia de demostración
 *               value: { patient_id: 1, doctor_id: 1, starts_at: '2030-01-10T14:00:00Z', ends_at: '2030-01-10T14:30:00Z' }
 *     responses:
 *       '201': { description: Cita creada (status inicial scheduled)., content: { application/json: { schema: { $ref: '#/components/schemas/Appointment' } } } }
 *       '400': { description: 'Fecha inválida, intervalo invertido o campo desconocido.', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '401': { description: Sin sesión., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: 'Sin permiso, CSRF inválido, o médico puro asignándose otro médico.', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409':
 *         description: El médico ya tiene una cita activa que se solapa con ese horario.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { status: error, message: The doctor already has an appointment that overlaps this time slot }
 *       '422': { description: 'Paciente/médico no válido para este consultorio, o cita en el pasado.', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   get:
 *     tags: [Citas]
 *     summary: Listar / filtrar citas
 *     description: >
 *       Requiere `appointments:read`. Un médico "puro" (sin `secretary`)
 *       siempre ve solo su propia agenda: cualquier doctor_id recibido se
 *       ignora y se fuerza al suyo.
 *     parameters:
 *       - { name: doctor_id, in: query, schema: { type: integer, minimum: 1 } }
 *       - { name: patient_id, in: query, schema: { type: integer, minimum: 1 } }
 *       - { name: status, in: query, schema: { $ref: '#/components/schemas/AppointmentStatus' } }
 *       - { name: from, in: query, schema: { type: string, format: date-time }, description: Filtra por starts_at >= from. }
 *       - { name: to, in: query, schema: { type: string, format: date-time }, description: Filtra por starts_at <= to. }
 *       - { name: page, in: query, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *     responses:
 *       '200': { description: Página de resultados., content: { application/json: { schema: { $ref: '#/components/schemas/AppointmentList' } } } }
 *       '401': { description: Sin sesión., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: Sin permiso `appointments:read`., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *
 * /appointments/{id}:
 *   parameters:
 *     - { name: id, in: path, required: true, schema: { type: integer, minimum: 1 } }
 *   get:
 *     tags: [Citas]
 *     summary: Consultar una cita
 *     description: >
 *       404 si no existe o pertenece a otro consultorio (mismo mensaje en
 *       ambos casos). 403 si existe y es de este consultorio pero quien
 *       llama es un médico "puro" que no es el doctor_id de esa cita.
 *     responses:
 *       '200': { description: Cita encontrada., content: { application/json: { schema: { $ref: '#/components/schemas/Appointment' } } } }
 *       '401': { description: Sin sesión., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: 'Sin permiso, o cita de otro médico.', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: No existe en el consultorio autorizado., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   patch:
 *     tags: [Citas]
 *     summary: Reprogramar o cambiar de estado una cita
 *     description: >
 *       Requiere `appointments:update`. Reglas en orden: existe y es
 *       accesible (404/403); no está en estado terminal
 *       (completed/cancelled -> 409); objeto vacío -> 422; transición de
 *       status válida según la máquina de estados (scheduled->confirmed|
 *       cancelled, confirmed->completed|cancelled; cualquier otra -> 409);
 *       intervalo completo resultante válido (422 si ends_at<=starts_at);
 *       nuevo starts_at no pasado (422); sin solapamiento con otra cita
 *       activa del mismo médico (409).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AppointmentUpdate' }
 *           examples:
 *             confirmar: { summary: Confirmar una cita programada, value: { status: confirmed } }
 *             reprogramar: { summary: Cambiar el horario, value: { starts_at: '2030-01-10T16:00:00Z', ends_at: '2030-01-10T16:30:00Z' } }
 *     responses:
 *       '200': { description: Cita actualizada., content: { application/json: { schema: { $ref: '#/components/schemas/Appointment' } } } }
 *       '400': { description: Campo desconocido (p. ej. intentar cambiar doctor_id) o fecha mal formada., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '401': { description: Sin sesión., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: 'Sin permiso, CSRF inválido, o cita de otro médico.', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: No existe en el consultorio autorizado., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: 'Estado terminal, transición inválida, o solapamiento.', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '422': { description: 'Objeto vacío, intervalo inválido, o nuevo horario en el pasado.', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *   delete:
 *     tags: [Citas]
 *     summary: Cancelar una cita (cancelación lógica)
 *     description: >
 *       Requiere `appointments:cancel`. **No borra la fila**: cambia su
 *       status a cancelled (sigue siendo consultable por GET). Es
 *       idempotente: cancelar una cita ya cancelada vuelve a responder
 *       204 sin error. Cancelar una cita completed responde 409.
 *     responses:
 *       '204': { description: Cancelada (o ya lo estaba). }
 *       '401': { description: Sin sesión., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: 'Sin permiso, CSRF inválido, o cita de otro médico.', content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '404': { description: No existe en el consultorio autorizado., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '409': { description: La cita ya está completed., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */

module.exports = {};
