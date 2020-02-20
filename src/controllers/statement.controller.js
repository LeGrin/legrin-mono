const Statement = require('../models/statement.model');
const Summary = require('../models/summary.model');
const Logs = require('../models/logs.model');

/**
 * Создать запись.
 */
module.exports.statement_create = async (req, res, next) => {
    try {
        const statements = await Statement.find();
    
        if (statements.filter(i => i.data.statementItem.id === req.body.data.statementItem.id).length > 0) {
            res.send('Statement already added!');
            return;
        } else {
            const newStatement = new Statement({
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
            });
            newStatement.save();
        }
    } catch(err) {
        const log = new Logs({
            time: Date.now(),
            message: err,
            payload: JSON.stringify(req.body)
        });
        log.save();
        return next(err);
    } 
    await updateSummary(req.body);
    res.send('Product created successfully!');  
    return;

};

updateSummary = async (body) => {
    var start = new Date();
    start.setHours(0,0,0,0);
    start = start.getTime();

    var end = new Date();
    end.setHours(23,59,59,999);
    end = end.getTime(); 
    
    let todaysSummary = (await Summary.find({date: start}))[0];
    if (!todaysSummary) {

        var yesterday = new Date(start);
        yesterday.setDate(yesterday.getDate()-1);
        yesterday.setHours(0,0,0,0);
        
        let yesterdaysSummary = Summary.find({date: yesterday})[0]
            || new Summary ({
                date: yesterday,
                limit: 100000,
                delta: 100000,
                spend: 0
            });

        todaysSummary = new Summary ({
            date: start,
            limit: yesterdaysSummary.limit,
            delta: yesterdaysSummary.delta + (yesterdaysSummary.limit + body.data.statementItem.amount),
            spend: body.data.statementItem.amount,
            statements: [body.data.statementItem.id]
        });
        await todaysSummary.save();
        console.log('Summary created ' + start);
      } else {
        todaysSummary.spend = todaysSummary.spend + body.data.statementItem.amount;
        todaysSummary.delta = todaysSummary.delta + (todaysSummary.limit + body.data.statementItem.amount);
        todaysSummary.statements.push(body.data.statementItem.id)
        await todaysSummary.save();
        console.log('Summary updated ' + start);
      }
}

/**
 * Получить список всех записей.
 */
module.exports.statement_all_details = async (req, res) => {
    try {
        var statements = await Statement.find();
        res.send(statements.sort((a,b) => a.data.statementItem.time > b.data.statementItem.time ? 1 : -1));
    } catch(err) {
        const log = new Logs({
            time: Date.now(),
            message: err,
            payload: JSON.stringify(req.body)
        });
        log.save();
        return next(err);
    }
}

/**
 * Получить запись по id.
 */
module.exports.statement_details = async (req, res, next) => {
    try {
        const statement = await Statement.findById(req.params.id);    
        res.send(statement);
    } catch(err) {
        const log = new Logs({
            time: Date.now(),
            message: err,
            payload: JSON.stringify(req.body)
        });
        log.save();
        return next(err);
    }
};

/**
 * Изменить запись по id.
 */
module.exports.statement_update = async (req, res, next) => {
    try {
        const statement = await Statement.findByIdAndUpdate(req.params.id, { $set: req.body });    
        res.send(statement);
    } catch(err) {
        const log = new Logs({
            time: Date.now(),
            message: err,
            payload: JSON.stringify(req.body)
        });
        log.save();
        return next(err);
    }
};

/**
 * Удалить запись по id.
 */
module.exports.statement_delete = async (req, res, next) => {
    try {
        const statement = await Statement.findByIdAndRemove(req.params.id);    
        res.send('Deleted successfully!');
    } catch(err) {
        const log = new Logs({
            time: Date.now(),
            message: err,
            payload: JSON.stringify(req.body)
        });
        log.save();
        return next(err);
    }
};