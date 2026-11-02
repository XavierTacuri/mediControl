'use strict';

const authRepository = require('../modules/auth/auth.repository');
const { computePermissions } = require('./requirePermission');

/**
 * Resuelve req.context = { clinicId, userId, roles, permissions } a partir
 * de la SESIÓN validada (nunca de datos enviados por el cliente: ni
 * X-Clinic-ID ni ningún campo de body/query deciden el consultorio o el
 * rol). Debe montarse después de requireAuth.
 *
 * Revalida en cada request (no solo al iniciar sesión):
 *   1. Que el usuario siga activo (pudo desactivarse después del login).
 *   2. Que exista un consultorio seleccionado en la sesión
 *      (POST /api/auth/clinic, o auto-seleccionado al login si el usuario
 *      pertenece a un único consultorio).
 *   3. Que el usuario siga siendo miembro de ESE consultorio (la
 *      membresía pudo revocarse después de seleccionarlo).
 *
 * Esta es la pieza que reemplaza al contexto DEMO (src/middlewares/
 * demoContext.js) cuando la app se ejecuta con autenticación real — ver
 * src/app.js.
 */
function createClinicContext({ db }) {
  return function clinicContext(req, res, next) {
    const user = authRepository.findActiveUserById(db, req.session.user.id);
    if (!user) {
      const err = new Error('Your account is no longer active');
      err.status = 401;
      return next(err);
    }

    const activeClinicId = req.session.activeClinicId;
    if (!activeClinicId) {
      const err = new Error('No clinic selected. Call POST /api/auth/clinic first.');
      err.status = 403;
      return next(err);
    }

    const roles = authRepository.findRolesForUserInClinic(db, { userId: user.id, clinicId: activeClinicId });
    if (roles.length === 0) {
      const err = new Error('You are not a member of the selected clinic');
      err.status = 403;
      return next(err);
    }

    req.context = Object.freeze({
      clinicId: activeClinicId,
      userId: user.id,
      roles,
      permissions: computePermissions(roles),
      source: 'session',
    });
    next();
  };
}

module.exports = { createClinicContext };
