const Summary = require('../models/summary.model');
const Logs = require('../models/logs.model');
const Statement = require('../models/statement.model');
const fetch = require('node-fetch');


module.exports.populate = async (req, res, next) => {
    var summaries = await Summary.find();
    var statements = await Statement.find();
    // clean
    summaries.forEach( summary => {
        Summary.findByIdAndRemove(summary._id, function (err) {
            if (err) return next(err);
        });
    });
    statements.forEach( summary => {
        Statement.findByIdAndRemove(summary._id, function (err) {
            if (err) return next(err);
        });
    });
    statements.forEach(async item => {

        if (item.data.statementItem.amount > 0) {
            return;
        }
        const date = new Date(item.data.statementItem.time*1000);
        date.setHours(0,0,0,0);
        var summary = await Summary.findOne({date: date});
        var yesterdaySummary = await  Summary.findOne({date: ( d => new Date(d.setDate(d.getDate()-1)) )(new Date)});
        if(summary === null)
        {
            console.log(yesterdaySummary != null ? (yesterdaySummary.delta + 80000 + item.data.statementItem.amount) 
            : 800 + item.data.statementItem.amount);
            summary = new Summary({
                date: date,
                limit: 80000,
                delta: yesterdaySummary != null ? (yesterdaySummary.delta + 80000 + item.data.statementItem.amount) 
                : 800 + item.data.statementItem.amount,
                spend: item.data.statementItem.amount * -1
            });
            summary.save(function (err) {
                if (err) return next(err);
                });
        } else {
            summary.delta = summary.delta + item.data.statementItem.amount;
            summary.spend = summary.spend + item.data.statementItem.amount * -1;
            summary.save(function (err) {
                if (err) return next(err);
                });
        }
    });
    summaries = await Summary.find();
    res.send(summaries);

};
/**
 * Получить список всех записей.
 */
module.exports.trigger = async (req, res) => {
    var start = new Date();
    start.setHours(0,0,0,0);

    var end = new Date();
    end.setHours(23,59,59,999);
    var todaysStatements = (await Statement.find())
    .filter(st => st.data.statementItem.time*1000 < end && st.data.statementItem.time*1000 > start);
    Statement.find({}, (err, items) => {


        const todays = items.filter(i => i.data.statementItem.time*1000 < end 
            && i.data.statementItem.time*1000 > start
            && i.data.statementItem.amount < 0);

        const spend = todays.reduce(function (accumulator, item) {
            return accumulator + item.data.statementItem.amount/100;
          }, 0);

        Summary.find({}, (err, items) => {
            let todaysSummary = items.filter(s => s.date === start)[0];
            console.log(items.length);
            if (todaysSummary === undefined) {

                var yesterday = ( d => new Date(d.setDate(d.getDate()-1)) )(new Date);
                yesterday.setHours(0,0,0,0);
                
                let yesterdaysSummary = items.filter(s => s.date === yesterday)[0] 
                    || new Summary ({
                        date: yesterday,
                        limit: 800,
                        delta: 0,
                        spend: 0
                    });

                todaysSummary = new Summary ({
                    date: start,
                    limit: yesterdaysSummary.limit,
                    delta: yesterdaysSummary.delta + (yesterdaysSummary.limit - spend * -1),
                    spend: spend * -1
                });
                todaysSummary.save(function (err) {
                    if (err) return next(err);
                    res.send('Summary Created successfully')
                });
              } else {
                todaysSummary.spend = spend * -1;
                todaysSummary.delta = todaysSummary.delta + (todaysSummary.limit - spend * -1);
                todaysSummary.save(function (err) {
                  if (err) return next(err);
                  res.send('Summary updated successfully');
                });
              }
            
              console.log('{ "value1" :' + todaysSummary.spend + ', "value2" : ' + todaysSummary.limit + ', "value3" : ' + todaysSummary.delta + '}');

            fetch('https://maker.ifttt.com/trigger/daily_summary/with/key/dHPVv2S_wlhUElyJaW4Pm3', {
            method: 'post',
            body: '{ "value1" :' + todaysSummary.spend + ', "value2" : ' + todaysSummary.limit + ', "value3" : ' + todaysSummary.delta + '}',
            headers: {"Content-Type":"application/json"}
            })
            .then(res => res.json())
            .then(json => console.log(json));
          });
    });
}
