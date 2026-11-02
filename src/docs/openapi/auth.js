'use strict';

/**
 * Documentación de /api/auth/* (ver src/modules/auth/*.js). Archivo
 * solo de anotaciones @openapi; no implementa ninguna ruta.
 *
 * @openapi
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       description: Nunca incluye password_hash.
 *       properties:
 *         id: { type: integer, example: 1 }
 *         name: { type: string, example: 'Médico de Prueba' }
 *         email: { type: string, format: email, example: medico.independiente@example.test }
 *       required: [id, name, email]
 *     ClinicMembership:
 *       type: object
 *       properties:
 *         clinic_id: { type: integer, example: 1 }
 *         clinic_name: { type: string, example: 'Consultorio Médico Demo' }
 *         roles:
 *           type: array
 *           items: { type: string, enum: [admin, doctor, secretary, nurse] }
 *           example: [admin, doctor, secretary]
 *       required: [clinic_id, clinic_name, roles]
 *     SessionResponse:
 *       type: object
 *       properties:
 *         user: { $ref: '#/components/schemas/User' }
 *         clinics:
 *           type: array
 *           items: { $ref: '#/components/schemas/ClinicMembership' }
 *         activeClinicId:
 *           type: integer
 *           nullable: true
 *           description: >
 *             null si el usuario pertenece a varios consultorios y todavía no ha
 *             llamado a POST /auth/clinic. Se auto-selecciona cuando solo
 *             pertenece a uno.
 *         csrfToken:
 *           type: string
 *           description: >
 *             Token para la cabecera X-CSRF-Token en toda escritura posterior.
 *             El cliente NO debe guardarlo en localStorage/sessionStorage.
 *       required: [user, clinics, activeClinicId]
 *
 * /auth/login:
 *   post:
 *     tags: [Autenticación]
 *     summary: Iniciar sesión
 *     description: >
 *       Sin autenticación previa ni CSRF (todavía no hay sesión con la que
 *       compararlo). Regenera el id de sesión en cada login exitoso
 *       (previene fijación de sesión) y aplica un límite de intentos
 *       fallidos por correo (ver LoginRateLimiter): tras varios fallos,
 *       responde 429 incluso con la contraseña correcta hasta que pasa la
 *       ventana de bloqueo.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email, example: medico.independiente@example.test }
 *               password: { type: string, format: password, example: contraseña-de-demostracion }
 *             required: [email, password]
 *     responses:
 *       '200':
 *         description: Credenciales válidas.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/SessionResponse' }
 *       '400':
 *         description: Cuerpo inválido (email mal formado, campos faltantes).
 *         content:
 *           application/json: { schema: { $ref: '#/components/schemas/Error' } }
 *       '401':
 *         description: >
 *           Credenciales inválidas. Mensaje genérico idéntico para usuario
 *           inexistente, contraseña incorrecta o cuenta desactivada — nunca
 *           revela cuál de los tres ocurrió.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { status: error, message: Invalid email or password }
 *       '429':
 *         description: Demasiados intentos fallidos recientes para este correo.
 *         content:
 *           application/json: { schema: { $ref: '#/components/schemas/Error' } }
 *
 * /auth/logout:
 *   post:
 *     tags: [Autenticación]
 *     summary: Cerrar sesión
 *     description: Destruye la sesión en el servidor y limpia la cookie.
 *     responses:
 *       '204': { description: Sesión cerrada. }
 *       '401': { description: No había sesión autenticada., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403': { description: Falta el token CSRF o no coincide., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *
 * /auth/me:
 *   get:
 *     tags: [Autenticación]
 *     summary: Perfil de la sesión actual
 *     description: Revalida que el usuario siga activo (no solo en el login).
 *     security: [{ sessionCookie: [] }]
 *     responses:
 *       '200':
 *         description: Sesión válida.
 *         content:
 *           application/json: { schema: { $ref: '#/components/schemas/SessionResponse' } }
 *       '401': { description: Sin sesión válida., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *
 * /auth/clinic:
 *   post:
 *     tags: [Autenticación]
 *     summary: Seleccionar consultorio activo
 *     description: >
 *       Solo admite un clinic_id del que el usuario sea realmente miembro
 *       (nunca uno arbitrario); se revalida la membresía en cada request
 *       posterior, no solo aquí.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties: { clinic_id: { type: integer, example: 2 } }
 *             required: [clinic_id]
 *     responses:
 *       '200':
 *         description: Consultorio activo actualizado.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { activeClinicId: { type: integer, example: 2 } }
 *       '400': { description: clinic_id inválido., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '401': { description: Sin sesión válida., content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       '403':
 *         description: El usuario no es miembro de ese consultorio, o falta/no coincide el CSRF.
 *         content:
 *           application/json: { schema: { $ref: '#/components/schemas/Error' } }
 */

module.exports = {};
