const Summary = require('../models/summary.model');
const Logs = require('../models/logs.model');
const Statement = require('../models/statement.model');
const fetch = require('node-fetch');


module.exports.populate = async (req, res, next) => {
    let summaries = await Summary.find();
    summaries = summaries.sort((a,b,) => a.date > b.date ? 1: -1);

    let statements = await Statement.find();
    statements = statements.sort((a,b) => {return a.data.statementItem.time > b.data.statementItem.time ? 1 : -1});
    // clean
    summaries.forEach( summary => {
        Summary.findByIdAndRemove(summary._id, function (err) {
            if (err) return next(err);
        });
    });

    let newSummaries = [];
    statements = statements.filter(st => st.data.statementItem.amount < 0);
    statements.forEach(async item => {

        let date = new Date(item.data.statementItem.time*1000);
        date.setHours(0,0,0,0);

        
        let yestredayDate = new Date(date.getTime());
        yestredayDate.setDate(date.getDate() - 1);
        
        yestredayDate.setHours(0,0,0,0);

        yestredayDate = yestredayDate.getTime();
        date = date.getTime();

        let summary = newSummaries.find(s => s.date === date);

        const yesterdaySummary = newSummaries.find(s => s.date === yestredayDate);

        if(!summary)
        {
            summary = new Summary({
                date: date,
                limit: 100000,
                delta: yesterdaySummary ? (yesterdaySummary.delta + 100000 + item.data.statementItem.amount) 
                : 100000 + item.data.statementItem.amount,
                spend: item.data.statementItem.amount,
                statements: [item.data.statementItem.id]
            });
            newSummaries.push(summary)
        } else {
            summary.delta = summary.delta + item.data.statementItem.amount;
            summary.spend = summary.spend + item.data.statementItem.amount;
            summary.statements.push(item.data.statementItem.id);
        }
    });
    newSummaries.forEach(async item => {
        await item.save();
    })
    //summaries = await Summary.find();
    res.send(newSummaries.sort((a,b) => a.date > b.date ? 1 : -1).map(ns => {
        return {
            date: new Date(ns.date), 
            delta : ns.delta/100,
            spend: ns.spend/100,
            count: ns.statements
        }
    }));

};

module.exports.get = async (req, res) => {
    let summaries = await Summary.find();
    summaries = summaries.sort((a,b,) => a.date > b.date ? 1: -1);
    res.send(summaries);
}
/**
 * Получить список всех записей.
 */
module.exports.trigger = async (req, res) => {
    var start = new Date();
    start.setHours(0,0,0,0);
    start = start.getTime();

    var end = new Date();
    end.setHours(23,59,59,999);
    end = end.getTime();

    var todaysStatements = (await Statement.find())
    .filter(st => st.data.statementItem.time*1000 < end 
        && st.data.statementItem.time*1000 > start);
    
    const spend = todaysStatements.reduce(function (accumulator, item) {
        return accumulator + item.data.statementItem.amount;
        }, 0);
    
    let todaysSummary = (await Summary.find({date: start}))[0];
   
      console.log('{ "value1" :' + todaysSummary.spend + ', "value2" : ' + todaysSummary.limit + ', "value3" : ' + todaysSummary.delta + '}');

      try {
        const response = await fetch('https://maker.ifttt.com/trigger/daily_summary/with/key/dHPVv2S_wlhUElyJaW4Pm3', {
            method: 'post',
            body: '{ "value1" :' + (todaysSummary.spend/100) * -1 + ', "value2" : ' + (todaysSummary.limit/100) + ', "value3" : ' 
            + (todaysSummary.delta/100) + '}',
            headers: {"Content-Type":"application/json"}
            });
        res.send(response);
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
