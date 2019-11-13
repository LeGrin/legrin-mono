const express = require('express');
const router = express.Router();

const summary_controller = require('../controllers/summary.controller');



/**
 * Получить список всех записей.
 */
router.get('/', summary_controller.trigger);
router.get('/getAll', summary_controller.get);
router.get('/populate', summary_controller.populate);

module.exports = router;