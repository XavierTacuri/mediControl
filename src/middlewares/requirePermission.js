'use strict';

/**
 * Matriz centralizada de permisos RBAC (Fase 5).
 *
 * Un permiso es una cadena "<recurso>:<acción>". Cada rol almacenado en
 * clinic_memberships otorga un conjunto fijo de permisos; un usuario con
 * varios roles en el mismo consultorio obtiene la UNIÓN de los permisos de
 * todos sus roles en ese consultorio (ver computePermissions). No hay
 * jerarquía implícita entre roles: cada permiso debe venir de un rol
 * realmente almacenado en la base de datos (ver Fase 5, sección 8:
 * "los permisos deben proceder de membresías y roles almacenados").
 *
 * Decisiones de diseño documentadas (ver también README):
 *
 * - `nurse` no tiene ningún permiso sobre patients/appointments en esta
 *   fase. El modelo de datos todavía no tiene una relación verificable de
 *   "agenda asignada a esta enfermera" (lo pide la Fase 5, sección 7); sin
 *   esa relación, se deniega en vez de inventar un acceso. Cuando esa
 *   asignación exista, el permiso correspondiente podrá limitarse por
 *   recurso igual que ya se hace con doctor_id (ver
 *   appointments.service.js).
 * - `admin` por sí solo NO otorga acceso clínico (ni patients ni
 *   appointments): solo `users:manage` y `clinic:configure` (sin
 *   endpoints todavía en esta fase). Un "médico independiente" obtiene
 *   acceso clínico completo
 *   porque también tiene el rol `secretary` (o `doctor`), no por tener
 *   `admin` combinado con cualquier otra cosa.
 * - `patients:delete` solo lo otorga `secretary` (y por extensión `admin`
 *   combinado con `secretary`), no `doctor`: borrar un registro de
 *   paciente se trata como una operación administrativa, no clínica.
 * - El alcance por recurso de `doctor` sobre citas (un médico solo
 *   gestiona SUS propias citas, salvo que también tenga `secretary`) no
 *   se modela aquí como un permiso distinto: se aplica en
 *   appointments.service.js (ver `hasClinicWideScheduling`), porque
 *   depende del recurso concreto (doctor_id de la cita), no solo del rol.
 */

const ROLE_PERMISSIONS = Object.freeze({
  doctor: Object.freeze([
    'patients:create',
    'patients:read',
    'patients:update',
    'appointments:create',
    'appointments:read',
    'appointments:update',
    'appointments:cancel',
  ]),
  secretary: Object.freeze([
    'patients:create',
    'patients:read',
    'patients:update',
    'patients:delete',
    'appointments:create',
    'appointments:read',
    'appointments:update',
    'appointments:cancel',
  ]),
  nurse: Object.freeze([]),
  admin: Object.freeze(['users:manage', 'clinic:configure']),
});

const ALL_PERMISSIONS = Object.freeze(
  Array.from(new Set(Object.values(ROLE_PERMISSIONS).flat())),
);

function computePermissions(roles) {
  const permissions = new Set();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] || []) {
      permissions.add(permission);
    }
  }
  return permissions;
}

function requirePermission(permission) {
  return function checkPermission(req, res, next) {
    if (!req.context || !req.context.permissions || !req.context.permissions.has(permission)) {
      const err = new Error('Insufficient permissions for this operation');
      err.status = 403;
      return next(err);
    }
    next();
  };
}

module.exports = { requirePermission, computePermissions, ROLE_PERMISSIONS, ALL_PERMISSIONS };
