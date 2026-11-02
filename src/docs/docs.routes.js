'use strict';

const express = require('express');
const { buildOpenApiSpec } = require('./openapiSpec');
const { createScalarRoute } = require('./scalarReference');

/**
 * Documentación interactiva de la API (Scalar + OpenAPI), montada bajo
 * /api desde src/app.js — habilitada SOLO fuera de producción (ver la
 * condición en createApp(); este router no decide eso, solo lo construye
 * cuando se le pide). No requiere sesión ni CSRF: es información pública
 * sobre el CONTRATO de la API en un entorno de desarrollo, no un dato
 * protegido; las operaciones que documenta siguen exigiendo su propia
 * autenticación/CSRF reales al ejecutarlas desde "Try it" en Scalar.
 *
 * No modifica el CRUD, RBAC, transacciones ni SSE existentes: solo lee
 * las anotaciones @openapi de src/docs/openapi/*.js.
 */
function createDocsRouter() {
  const router = express.Router();

  // Se construye una sola vez por proceso (escanear los archivos de
  // anotaciones en cada petición sería trabajo repetido e innecesario).
  const spec = buildOpenApiSpec();

  router.get('/openapi.json', (req, res) => {
    res.status(200).json(spec);
  });

  router.get(
    '/docs',
    createScalarRoute({
      url: '/api/openapi.json',
      pageTitle: 'MediControl API Reference',
    }),
  );

  return router;
}

module.exports = { createDocsRouter };
