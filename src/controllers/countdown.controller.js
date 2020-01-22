const Countdown = require('../models/countdown.model');
const fetch = require('node-fetch');

module.exports.schedule_ping = async (req, res) => {
    let countdown = await Countdown.find()[0];
    if (!countdown) {
        countdown = new Countdown({
            time: Date.now(),
            scheduled: true
        });
    } else {
        countdown.time = Date.now();
        countdown.scheduled = true;
    }
    countdown.save();
    res.send('OK');
}

module.exports.get_schedule = async (req, res) => {
    let countdown = (await Countdown.find())[0];
    if (countdown && countdown.scheduled) {
        res.send('true');
        countdown.scheduled = false;
        countdown.save();
    }
    res.send('false');
}