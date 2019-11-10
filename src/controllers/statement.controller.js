const Statement = require('../models/statement.model');

/**
 * Создать запись.
 */
module.exports.statement_create = function (req, res, next) {
    console.log(req.body);
    Statement.create({
        type: req.body.type,
        data: {
            account: req.body.data.account,
            statementItem:   {
                id: req.body.data.statementItem.id,
                time: req.body.data.statementItem.time,
                description: req.body.data.statementItem.description,
                mcc: req.body.data.statementItem.mcc,
                hold: req.body.data.statementItem.hold,
                amount: req.body.data.statementItem.amount,
                operationAmount: req.body.data.statementItem.operationAmount,
                currencyCode: req.body.data.statementItem.currencyCode,
                commissionRate: req.body.data.statementItem.commissionRate,
                cashbackAmount: req.body.data.statementItem.cashbackAmount,
                balance: req.body.data.statementItem.balance
              }
        }
    }, function (err) {
        if (err) return next(err);
        res.send('Product created successfully!');
    });
    
    /*
        Можно создать запись и так:

        let product = new Product({
            name: req.body.name,
            price: req.body.price
        });

        product.save(function (err) {
            if (err) return next(err);
            res.send('Product Created successfully')
        });
    */
};

/**
 * Получить список всех записей.
 */
module.exports.statement_all_details = function (req, res) {
    Statement.find({}, (err, items) => {
        res.send(items);
    });
}

/**
 * Получить запись по id.
 */
module.exports.statement_details = function (req, res, next) {
    Statement.findById(req.params.id, function (err, product) {
        if (err) return next(err);
        res.send(product);
    });
};

/**
 * Изменить запись по id.
 */
module.exports.statement_update = function (req, res, next) {
    Statement.findByIdAndUpdate(req.params.id, { $set: req.body }, function (err, product) {
        if (err) return next(err);
        res.send('Product udpated.');
    });
};

/**
 * Удалить запись по id.
 */
module.exports.statement_delete = function (req, res, next) {
    console.log(req.params);
    Statement.findByIdAndRemove(req.params.id, function (err) {
        if (err) return next(err);
        res.send('Deleted successfully!');
    });
};