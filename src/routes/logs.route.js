const express = require('express');
const router = express.Router();

const logs_controller = require('../controllers/logs.controller');



/**
 * Получить список всех записей.
 */
router.get('/', logs_controller.all_logs);


module.exports = router;