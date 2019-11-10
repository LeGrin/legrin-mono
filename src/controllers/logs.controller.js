const Logs = require('../models/logs.model');

/**
 * Получить список всех записей.
 */
module.exports.all_logs = function (req, res) {
    Logs.find({}, (err, items) => {
        res.send(items);
    });
}