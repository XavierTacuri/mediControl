'use strict';

const bcrypt = require('bcryptjs');
const repository = require('./auth.repository');

class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.status = 401;
  }
}

class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.status = 403;
  }
}

class TooManyAttemptsError extends Error {
  constructor(message = 'Too many failed login attempts. Try again later.') {
    super(message);
    this.status = 429;
  }
}

// Mensaje intencionalmente genérico: usuario inexistente, contraseña
// incorrecta y usuario desactivado responden EXACTAMENTE lo mismo, para no
// revelar si una cuenta existe (Fase 5, sección 4).
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

// Hash bcrypt "señuelo" calculado una sola vez al cargar el módulo: cuando
// el email no existe, igualmente se ejecuta un bcrypt.compare contra este
// hash para que el tiempo de respuesta no delate (por timing) si el email
// existe o no.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('medicontrol-timing-placeholder', 10);

/**
 * Limitador de intentos de login en memoria, por correo normalizado.
 * Usa la misma fuente de tiempo inyectable que el resto de la app (ver
 * createApp({ clock })) para que las pruebas sean deterministas.
 *
 * Limitación conocida: el estado vive en memoria de un solo proceso, así
 * que no protege entre réplicas de la aplicación ni sobrevive un reinicio.
 * Para un despliegue multi-instancia haría falta moverlo a un almacén
 * compartido (p. ej. la misma tabla `sessions`/una tabla dedicada); fuera
 * de alcance de esta fase académica.
 */
class LoginRateLimiter {
  constructor({ clock, maxAttempts = 5, lockoutMs = 60_000 }) {
    this.clock = clock;
    this.maxAttempts = maxAttempts;
    this.lockoutMs = lockoutMs;
    this.attempts = new Map();
  }

  assertNotLocked(email) {
    const entry = this.attempts.get(email);
    if (entry && entry.lockedUntil > this.clock.now().getTime()) {
      throw new TooManyAttemptsError();
    }
  }

  recordFailure(email) {
    const now = this.clock.now().getTime();
    const entry = this.attempts.get(email) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= this.maxAttempts) {
      entry.lockedUntil = now + this.lockoutMs;
      entry.count = 0;
    }
    this.attempts.set(email, entry);
  }

  recordSuccess(email) {
    this.attempts.delete(email);
  }
}

function sanitizeUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function login(db, { email, password, clock, rateLimiter }) {
  rateLimiter.assertNotLocked(email);

  const user = repository.findUserByEmail(db, email);
  const passwordHash = user ? user.password_hash : DUMMY_PASSWORD_HASH;
  const passwordMatches = bcrypt.compareSync(password, passwordHash);

  if (!user || !user.active || !passwordMatches) {
    rateLimiter.recordFailure(email);
    throw new UnauthorizedError(INVALID_CREDENTIALS_MESSAGE);
  }

  rateLimiter.recordSuccess(email);

  const memberships = repository.findMembershipsForUser(db, user.id);
  return { user: sanitizeUser(user), memberships };
}

function getCurrentUser(db, { userId }) {
  const user = repository.findActiveUserById(db, userId);
  if (!user) {
    throw new UnauthorizedError('Your account is no longer active');
  }
  const memberships = repository.findMembershipsForUser(db, user.id);
  return { user: sanitizeUser(user), memberships };
}

function selectClinic(db, { userId, clinicId }) {
  const memberships = repository.findMembershipsForUser(db, userId);
  const isMember = memberships.some((membership) => membership.clinic_id === clinicId);
  if (!isMember) {
    throw new ForbiddenError('You are not a member of that clinic');
  }
  return clinicId;
}

module.exports = {
  login,
  getCurrentUser,
  selectClinic,
  LoginRateLimiter,
  UnauthorizedError,
  ForbiddenError,
  TooManyAttemptsError,
  INVALID_CREDENTIALS_MESSAGE,
};
