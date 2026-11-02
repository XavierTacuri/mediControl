'use strict';

const { ROLE_PERMISSIONS, ALL_PERMISSIONS } = require('./requirePermission');

/**
 * Contexto de autorización DEMO — mecanismo de INYECCIÓN DE CONTEXTO PARA
 * PRUEBAS, separado de la autenticación real (Fase 5).
 *
 * Desde la Fase 5, las rutas de /api/patients y /api/appointments están
 * protegidas por sesión real (requireAuth + clinicContext, ver
 * src/app.js). El modo DEMO sigue existiendo como un atajo que solo
 * `createApp({ demoMode: true, ... })` puede activar desde código — jamás
 * desde una petición HTTP (ningún header, cookie o parámetro lo controla).
 * Por eso basta con una guardia en app.js: en producción, `demoMode`
 * SIEMPRE se evalúa como false sin importar lo que pida el llamador (ver
 * createApp en src/app.js), así que esta rama nunca queda expuesta fuera
 * de un proceso de pruebas o de desarrollo local que la invoque a propósito.
 *
 * El contexto resultante tiene todos los permisos (ALL_PERMISSIONS) para
 * no obligar a cada prueba de Fase 3/4 a simular roles — esas pruebas
 * verifican lógica de negocio (CRUD, solapamientos, transiciones), no
 * RBAC; las pruebas de RBAC usan sesiones reales (ver tests/rbac.test.js).
 */

function ensureDemoClinic(db, clinicName) {
  const existing = db.prepare('SELECT id FROM clinics WHERE name = ?').get(clinicName);
  if (existing) {
    return existing.id;
  }
  const result = db.prepare('INSERT INTO clinics (name) VALUES (?)').run(clinicName);
  return result.lastInsertRowid;
}

function createDemoContext({ db, clinicId, clinicName = 'Consultorio Demo' }) {
  const resolvedClinicId = clinicId ?? ensureDemoClinic(db, clinicName);
  const roles = Object.keys(ROLE_PERMISSIONS);

  return function demoContext(req, res, next) {
    req.context = Object.freeze({
      clinicId: resolvedClinicId,
      userId: null,
      roles,
      permissions: new Set(ALL_PERMISSIONS),
      source: 'demo',
    });
    next();
  };
}

module.exports = { createDemoContext, ensureDemoClinic };
