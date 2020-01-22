const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const CountdownSchema = new Schema({
    time: {
        type: Date,
        reuired: true
    },
    scheduled: {
        type: Boolean,
        required: true
    }
});

module.exports = mongoose.model('Countdown', CountdownSchema);
