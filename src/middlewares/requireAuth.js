'use strict';

// Exige una sesión autenticada (ver auth.controller.js: req.session.user se
// fija al iniciar sesión). No consulta la base de datos ni revalida que el
// usuario siga activo: eso lo hace clinicContext.js en cada request para
// las rutas que necesitan clinic_id (patients/appointments). requireAuth
// por sí solo basta para /api/auth/me y /api/auth/logout.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user || !req.session.user.id) {
    const err = new Error('Authentication required');
    err.status = 401;
    return next(err);
  }
  next();
}

module.exports = { requireAuth };
