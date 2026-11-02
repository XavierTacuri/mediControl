'use strict';

// Única capa que conoce SQL para autenticación y membresías. Todas las
// consultas están parametrizadas.

function findUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function findActiveUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id);
}

// Todas las membresías (y roles) del usuario, con el nombre del
// consultorio para que el cliente pueda mostrar un selector.
function findMembershipsForUser(db, userId) {
  return db
    .prepare(
      `SELECT clinic_memberships.clinic_id AS clinic_id,
              clinics.name AS clinic_name,
              clinic_memberships.role AS role
       FROM clinic_memberships
       JOIN clinics ON clinics.id = clinic_memberships.clinic_id
       WHERE clinic_memberships.user_id = ?
       ORDER BY clinic_memberships.clinic_id, clinic_memberships.role`,
    )
    .all(userId);
}

// Roles del usuario en un consultorio concreto (vacío si no es miembro).
// clinicContext.js la usa en CADA request para revalidar la membresía.
function findRolesForUserInClinic(db, { userId, clinicId }) {
  const rows = db
    .prepare('SELECT role FROM clinic_memberships WHERE user_id = ? AND clinic_id = ?')
    .all(userId, clinicId);
  return rows.map((row) => row.role);
}

module.exports = {
  findUserByEmail,
  findActiveUserById,
  findMembershipsForUser,
  findRolesForUserInClinic,
};
