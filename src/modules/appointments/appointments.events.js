'use strict';

const authRepository = require('../auth/auth.repository');
const { computePermissions } = require('../../middlewares/requirePermission');
const { hasClinicWideScheduling } = require('./appointments.service');

const DEFAULT_HEARTBEAT_MS = 15000;
const REQUIRED_PERMISSION = 'appointments:read';

function formatSseMessage(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Revalida la autorización de una conexión SSE ya abierta. No basta con
 * comprobarla al conectar (Fase 6, sección 10): una conexión puede durar
 * minutos, y mientras tanto el usuario puede cerrar sesión (en otra
 * pestaña/petición), su sesión puede vencer, su membresía puede revocarse,
 * o puede cambiar de consultorio activo con POST /api/auth/clinic. Esta
 * función detecta los cuatro casos consultando directamente la fila de la
 * sesión en SQLite (nunca el `req.session` capturado al conectar, que es
 * solo una fotografía del momento en que se abrió el EventSource).
 *
 * En modo DEMO (pruebas con contexto inyectado, sin sesión real) siempre
 * es válida: no hay sesión que revalidar.
 */
function createRevalidator({ db, sid, userId, clinicId, isDemo }) {
  if (isDemo) {
    return () => true;
  }

  return function revalidate() {
    const row = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
    if (!row || row.expires_at <= Date.now()) {
      return false; // logout, o sesión vencida
    }

    let sessionData;
    try {
      sessionData = JSON.parse(row.data);
    } catch {
      return false;
    }

    if (!sessionData.user || sessionData.user.id !== userId) return false;
    if (sessionData.activeClinicId !== clinicId) return false; // cambió de consultorio

    const user = authRepository.findActiveUserById(db, userId);
    if (!user) return false; // cuenta desactivada

    const roles = authRepository.findRolesForUserInClinic(db, { userId, clinicId });
    if (roles.length === 0) return false; // membresía revocada

    return computePermissions(roles).has(REQUIRED_PERMISSION);
  };
}

/**
 * GET /api/appointments/events — canal SSE de notificaciones de citas.
 *
 * Se monta DETRÁS de requireAuth + csrfProtection + clinicContext (o del
 * contexto DEMO, en pruebas) igual que el resto de /api/appointments —
 * ver src/app.js. requirePermission('appointments:read') ya se aplica a
 * nivel de ruta (appointments.routes.js); esta función además filtra, por
 * cada evento, lo que puede ver un médico "puro" (solo sus propias
 * citas) frente a quien gestiona toda la agenda del consultorio.
 */
function appointmentEvents(req, res, next) {
  const db = req.app.get('db');
  const broker = req.app.get('appointmentBroker');
  const heartbeatMs = req.app.get('sseHeartbeatMs') || DEFAULT_HEARTBEAT_MS;
  const context = req.context;
  const isDemo = context.source === 'demo';
  const userKey = context.userId ?? 'demo';

  if (!broker.tryAcquireConnection(userKey)) {
    const err = new Error('Too many concurrent SSE connections for this account');
    err.status = 429;
    return next(err);
  }

  const revalidate = createRevalidator({
    db,
    sid: req.sessionID,
    userId: context.userId,
    clinicId: context.clinicId,
    isDemo,
  });

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Evita que un proxy inverso (p. ej. nginx) almacene en búfer la
    // respuesta en vez de transmitirla de inmediato.
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  // Comentario inicial de conexión (formato SSE: una línea que empieza con
  // ':' se ignora como dato, pero confirma al cliente que el canal está
  // abierto). Nunca lleva información sensible.
  res.write(': connected\n\n');

  let closed = false;
  let heartbeatTimer = null;
  let unsubscribe = () => {};

  function close() {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    unsubscribe();
    broker.releaseConnection(userKey);
    res.end();
  }

  function deliver(event) {
    if (closed) return;

    // Alcance por recurso: un médico "puro" solo recibe eventos de SUS
    // propias citas, igual que en la API REST (ver
    // appointments.service.js / hasClinicWideScheduling). El broker ya
    // filtró por consultorio; esto filtra además por médico.
    if (!hasClinicWideScheduling(context) && event.data.doctor_id !== context.userId) {
      return;
    }

    if (!revalidate()) {
      close();
      return;
    }

    try {
      res.write(formatSseMessage(event.type, event.data));
    } catch {
      close();
    }
  }

  unsubscribe = broker.subscribe(context.clinicId, { deliver, close });

  heartbeatTimer = setInterval(() => {
    if (!revalidate()) {
      close();
      return;
    }
    try {
      res.write(': heartbeat\n\n');
    } catch {
      close();
    }
  }, heartbeatMs);

  req.on('close', close);
}

module.exports = { appointmentEvents, formatSseMessage, createRevalidator };
