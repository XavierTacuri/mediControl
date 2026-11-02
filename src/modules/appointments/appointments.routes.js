'use strict';

const express = require('express');
const controller = require('./appointments.controller');
const { appointmentEvents } = require('./appointments.events');
const { requirePermission } = require('../../middlewares/requirePermission');

const router = express.Router();

// Debe registrarse ANTES de GET /:id: si no, Express interpretaría
// "events" como un :id y la petición nunca llegaría aquí (fallaría con
// 400 por "events" no ser un entero positivo).
router.get('/events', requirePermission('appointments:read'), appointmentEvents);
router.get('/doctors', requirePermission('appointments:read'), controller.listDoctors);

router.post('/', requirePermission('appointments:create'), controller.createAppointment);
router.get('/', requirePermission('appointments:read'), controller.listAppointments);
router.get('/:id', requirePermission('appointments:read'), controller.getAppointment);
router.patch('/:id', requirePermission('appointments:update'), controller.updateAppointment);
router.delete('/:id', requirePermission('appointments:cancel'), controller.cancelAppointment);

module.exports = router;
