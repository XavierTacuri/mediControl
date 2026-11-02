'use strict';

const crypto = require('node:crypto');
const service = require('./auth.service');
const { loginSchema, selectClinicSchema } = require('./auth.schema');

function toValidationError(zodError) {
  const err = new Error('Request validation failed');
  err.status = 400;
  err.details = zodError.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  return err;
}

function parse(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw toValidationError(result.error);
  }
  return result.data;
}

// Agrupa las filas (clinic_id, clinic_name, role) por consultorio para que
// el cliente reciba una lista de roles por consultorio, no una fila por rol.
function groupMembershipsByClinic(memberships) {
  const byClinic = new Map();
  for (const membership of memberships) {
    const entry = byClinic.get(membership.clinic_id) || {
      clinic_id: membership.clinic_id,
      clinic_name: membership.clinic_name,
      roles: [],
    };
    entry.roles.push(membership.role);
    byClinic.set(membership.clinic_id, entry);
  }
  return Array.from(byClinic.values());
}

function login(req, res, next) {
  try {
    const { email, password } = parse(loginSchema, req.body);
    const db = req.app.get('db');
    const clock = req.app.get('clock');
    const rateLimiter = req.app.get('loginRateLimiter');

    const { user, memberships } = service.login(db, { email, password, clock, rateLimiter });
    const clinics = groupMembershipsByClinic(memberships);

    // Regenerar el id de sesión en cada login evita la fijación de sesión
    // (session fixation): un id de sesión obtenido antes de autenticarse
    // nunca queda "promovido" a una sesión autenticada.
    req.session.regenerate((regenerateErr) => {
      if (regenerateErr) return next(regenerateErr);

      req.session.user = { id: user.id };
      req.session.activeClinicId = clinics.length === 1 ? clinics[0].clinic_id : null;
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');

      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        res.status(200).json({
          user,
          clinics,
          activeClinicId: req.session.activeClinicId,
          csrfToken: req.session.csrfToken,
        });
      });
    });
  } catch (err) {
    next(err);
  }
}

function logout(req, res, next) {
  if (!req.session) {
    return res.status(204).send();
  }
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('medicontrol.sid');
    res.status(204).send();
  });
}

function me(req, res, next) {
  try {
    const db = req.app.get('db');
    const { user, memberships } = service.getCurrentUser(db, { userId: req.session.user.id });
    res.status(200).json({
      user,
      clinics: groupMembershipsByClinic(memberships),
      activeClinicId: req.session.activeClinicId || null,
      // El frontend nunca persiste el token CSRF (ni localStorage ni
      // sessionStorage, ver README): vive solo en memoria de la pestaña
      // y se pierde en cada recarga de página. Devolverlo también aquí
      // (ya existe en la sesión desde el login, no se genera uno nuevo)
      // permite recuperar una sesión activa tras un refresh sin tener
      // que volver a iniciar sesión.
      csrfToken: req.session.csrfToken,
    });
  } catch (err) {
    next(err);
  }
}

function selectClinic(req, res, next) {
  try {
    const { clinic_id: clinicId } = parse(selectClinicSchema, req.body);
    const db = req.app.get('db');
    service.selectClinic(db, { userId: req.session.user.id, clinicId });

    req.session.activeClinicId = clinicId;
    req.session.save((err) => {
      if (err) return next(err);
      res.status(200).json({ activeClinicId: clinicId });
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, logout, me, selectClinic };
