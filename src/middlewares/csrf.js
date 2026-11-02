'use strict';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER = 'x-csrf-token';

/**
 * Protección CSRF (patrón "synchronizer token"): al iniciar sesión
 * (auth.controller.js) se genera un token aleatorio y se guarda en
 * req.session.csrfToken; el cliente debe reenviarlo en la cabecera
 * X-CSRF-Token en toda petición que modifique datos. Como la cookie de
 * sesión es HttpOnly (no legible por JS) y SameSite=lax, un sitio de
 * terceros no puede leer el token ni, salvo casos límite de navegación de
 * nivel superior, provocar que el navegador adjunte la cookie en una
 * petición cross-site que modifique datos; este token es una segunda
 * barrera explícita además de esas protecciones de la cookie.
 *
 * Los métodos seguros (GET/HEAD/OPTIONS) no requieren el token. Solo se
 * aplica en la rama de autenticación real: el modo DEMO (pruebas con
 * contexto inyectado, ver demoContext.js) no pasa por aquí.
 */
function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const sessionToken = req.session && req.session.csrfToken;
  const headerToken = req.get(CSRF_HEADER);

  if (!sessionToken || !headerToken || headerToken !== sessionToken) {
    const err = new Error('Invalid or missing CSRF token');
    err.status = 403;
    return next(err);
  }

  next();
}

module.exports = { csrfProtection, CSRF_HEADER };
