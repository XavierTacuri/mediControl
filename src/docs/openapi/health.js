'use strict';

/**
 * Archivo exclusivamente de documentación: no define ninguna ruta ni
 * lógica, solo anotaciones @openapi que swagger-jsdoc (ver
 * src/docs/openapiSpec.js) escanea para construir el documento OpenAPI.
 * La implementación real del endpoint vive en src/app.js, sin cambios.
 *
 * @openapi
 * /health:
 *   get:
 *     tags: [Salud]
 *     summary: Estado del servicio
 *     description: >
 *       Único endpoint público sin autenticación. Sirve para comprobar que
 *       el backend está arriba (p. ej. desde un balanceador de carga).
 *     security: []
 *     responses:
 *       '200':
 *         description: El servicio está operativo.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: ok }
 *                 application: { type: string, example: MediControl }
 *                 version: { type: string, example: '1.0.0' }
 *               required: [status, application, version]
 */

module.exports = {};
