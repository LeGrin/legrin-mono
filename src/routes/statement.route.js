const express = require('express');
const router = express.Router();

const statement_controller = require('../controllers/statement.controller');

/**
 * Создать запись.
 */
router.post('/create', statement_controller.statement_create);

/**
 * Получить список всех записей.
 */
router.get('/', statement_controller.statement_all_details);

/**
 * Получить запись по id.
 */
router.get('/:id', statement_controller.statement_details);

/**
 * Изменить запись по id.
 */
router.put('/:id/update', statement_controller.statement_update);

/**
 * Удалить запись по id.
 */
router.delete('/:id/delete', statement_controller.statement_delete);

module.exports = router;