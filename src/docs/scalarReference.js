'use strict';

/**
 * @scalar/express-api-reference es un paquete ESM-only ("type": "module",
 * usa `export`), mientras que este backend es CommonJS ("type":
 * "commonjs"). No se puede `require()` directamente (lanzaría
 * ERR_REQUIRE_ESM); la forma estándar de consumir un paquete ESM-only
 * desde código CJS es un `import()` dinámico, que siempre devuelve una
 * Promise incluso desde CJS.
 *
 * Para no convertir todo el backend a ESM solo por esta dependencia de
 * documentación, el import se hace de forma perezosa (en la primera
 * petición a /api/docs) y se cachea: las peticiones siguientes reutilizan
 * el mismo handler ya resuelto, sin volver a pagar el costo del import().
 */
let cachedHandlerPromise = null;

function getScalarHandler(config) {
  if (!cachedHandlerPromise) {
    cachedHandlerPromise = import('@scalar/express-api-reference').then(({ apiReference }) => apiReference(config));
  }
  return cachedHandlerPromise;
}

function createScalarRoute(config) {
  return function scalarReferenceRoute(req, res, next) {
    getScalarHandler(config)
      .then((handler) => handler(req, res, next))
      .catch(next);
  };
}

module.exports = { createScalarRoute };
