'use strict';

const express = require('express');
const session = require('express-session');
const { loadConfig } = require('./config/env');
const { notFoundHandler, errorHandler } = require('./middlewares/errorHandler');
const { createDemoContext } = require('./middlewares/demoContext');
const { requireAuth } = require('./middlewares/requireAuth');
const { createClinicContext } = require('./middlewares/clinicContext');
const { csrfProtection } = require('./middlewares/csrf');
const { SqliteSessionStore } = require('./middlewares/sqliteSessionStore');
const { getDatabase } = require('./db/database');
const { LoginRateLimiter } = require('./modules/auth/auth.service');
const { AppointmentBroker } = require('./events/appointmentBroker');
const { createDocsRouter } = require('./docs/docs.routes');
const authRouter = require('./modules/auth/auth.routes');
const patientsRouter = require('./modules/patients/patients.routes');
const appointmentsRouter = require('./modules/appointments/appointments.routes');

/**
 * @param {object} [overrides]
 * @param {import('better-sqlite3').Database} [overrides.db] Conexión a usar
 *   (inyectable para pruebas con bases de datos aisladas). Si se omite, se
 *   reutiliza la conexión por defecto según DATABASE_PATH.
 * @param {boolean} [overrides.demoMode] Activa el contexto DEMO (inyección
 *   directa de clinic_id, sin pasar por sesión/login) en vez de la
 *   autenticación real — SOLO para pruebas automatizadas y demostración
 *   local. Ignorado (forzado a false) cuando NODE_ENV=production, sin
 *   importar lo que pida el llamador: ver la guardia más abajo.
 * @param {number} [overrides.demoClinicId] Fija el clinic_id del contexto
 *   DEMO en lugar de resolverlo/crearlo automáticamente.
 * @param {{ now: () => Date }} [overrides.clock] Fuente de tiempo inyectable
 *   (citas en el pasado, expiración de sesión, límite de intentos de
 *   login). Por defecto usa el reloj real del sistema.
 * @param {import('./modules/auth/auth.service').LoginRateLimiter} [overrides.loginRateLimiter]
 *   Limitador de intentos de login inyectable (pruebas deterministas).
 * @param {import('./events/appointmentBroker').AppointmentBroker} [overrides.appointmentBroker]
 *   Broker SSE inyectable (pruebas aisladas; cada createApp() crea uno
 *   propio por defecto, nunca comparten estado entre sí).
 * @param {number} [overrides.sseHeartbeatMs] Intervalo del heartbeat SSE y
 *   de la revalidación periódica de sesión (por defecto 15000 ms; las
 *   pruebas usan un valor mucho menor para no esperar segundos reales).
 * @param {boolean} [overrides.enableDocs] Fuerza /api/docs y
 *   /api/openapi.json on/off. Por defecto, activos fuera de producción.
 *   Igual que demoMode: en producción SIEMPRE quedan desactivados, sin
 *   importar este override (ver la guardia más abajo) — la documentación
 *   interactiva no debe quedar expuesta públicamente por defecto.
 */
function createApp(overrides = {}) {
  const config = loadConfig();
  const db = overrides.db || getDatabase(config.DATABASE_PATH);
  const clock = overrides.clock || { now: () => new Date() };
  const loginRateLimiter = overrides.loginRateLimiter || new LoginRateLimiter({ clock });
  const appointmentBroker = overrides.appointmentBroker || new AppointmentBroker();
  const docsEnabled = config.isProduction ? false : overrides.enableDocs !== undefined ? overrides.enableDocs : true;

  // Guardia de defensa en profundidad: en producción el modo DEMO está
  // SIEMPRE desactivado, incluso si algo pasara `demoMode: true` por error
  // (código propio, un script, etc.) — nunca solo por config, también en
  // el punto exacto donde se decide la rama de autorización. El modo DEMO
  // únicamente puede activarlo código del propio proceso (tests, scripts
  // locales); ninguna petición HTTP puede activarlo por sí misma.
  const demoMode = config.isProduction ? false : overrides.demoMode !== undefined ? overrides.demoMode : config.DEMO_MODE;

  const app = express();

  app.disable('x-powered-by');
  app.set('db', db);
  app.set('clock', clock);
  app.set('loginRateLimiter', loginRateLimiter);
  app.set('appointmentBroker', appointmentBroker);
  app.set('sseHeartbeatMs', overrides.sseHeartbeatMs || 15000);
  app.use(express.json({ limit: '32kb' }));

  app.use(
    session({
      store: new SqliteSessionStore({ db, ttlMs: config.SESSION_TTL_MS }),
      secret: config.SESSION_SECRET,
      name: 'medicontrol.sid',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        // 'lax' es apropiado para un frontend propio del mismo sitio (no
        // se debilita a 'none', que exigiría exponer la cookie entre
        // sitios); ver README, sección "Seguridad y sesiones".
        sameSite: 'lax',
        secure: config.isProduction,
        maxAge: config.SESSION_TTL_MS,
      },
    }),
  );

  app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok', application: config.APP_NAME, version: config.APP_VERSION });
  });

  // Documentación interactiva (Scalar + OpenAPI): GET /api/docs y
  // GET /api/openapi.json. Pública (sin sesión/CSRF: es el CONTRATO de la
  // API, no un dato protegido) pero solo fuera de producción — ver
  // docsEnabled arriba y src/docs/docs.routes.js.
  if (docsEnabled) {
    app.use('/api', createDocsRouter());
  }

  app.use('/api/auth', authRouter);

  // Rama DEMO (pruebas/demo local) vs. rama de autenticación real. Nunca
  // ambas a la vez: el modo DEMO sustituye por completo a requireAuth +
  // clinicContext (incluida la protección CSRF, que no aplica sin sesión
  // real) — ver demoContext.js y csrf.js para el razonamiento completo.
  const protectedContext = demoMode
    ? [createDemoContext({ db, clinicId: overrides.demoClinicId, clinicName: config.DEMO_CLINIC_NAME })]
    : [requireAuth, csrfProtection, createClinicContext({ db })];

  app.use('/api/patients', ...protectedContext, patientsRouter);
  app.use('/api/appointments', ...protectedContext, appointmentsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
