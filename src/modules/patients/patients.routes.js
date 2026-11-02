'use strict';

const express = require('express');
const controller = require('./patients.controller');
const { requirePermission } = require('../../middlewares/requirePermission');

const router = express.Router();

router.post('/', requirePermission('patients:create'), controller.createPatient);
router.get('/', requirePermission('patients:read'), controller.listPatients);
router.get('/:id', requirePermission('patients:read'), controller.getPatient);
router.patch('/:id', requirePermission('patients:update'), controller.updatePatient);
router.delete('/:id', requirePermission('patients:delete'), controller.deletePatient);

module.exports = router;
