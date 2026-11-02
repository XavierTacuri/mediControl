'use strict';

const express = require('express');
const controller = require('./auth.controller');
const { requireAuth } = require('../../middlewares/requireAuth');
const { csrfProtection } = require('../../middlewares/csrf');

const router = express.Router();

// Login no requiere sesión previa ni CSRF (todavía no hay token de sesión
// con el que compararlo). El resto de rutas sí requieren una sesión
// autenticada, y las que mutan estado (logout, cambiar de consultorio)
// exigen además el token CSRF emitido en el login.
router.post('/login', controller.login);
router.post('/logout', requireAuth, csrfProtection, controller.logout);
router.get('/me', requireAuth, controller.me);
router.post('/clinic', requireAuth, csrfProtection, controller.selectClinic);

module.exports = router;
