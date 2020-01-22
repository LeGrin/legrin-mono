const express = require('express');
const router = express.Router();

const countdown_controller = require('../controllers/countdown.controller');

/**
 * Создать запись.
 */
router.post('/ping', countdown_controller.schedule_ping);

/**
 * Получить список всех записей.
 */
router.get('/pong', countdown_controller.get_schedule);

module.exports = router;