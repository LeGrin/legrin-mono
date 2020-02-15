const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const CalendarSchema = new Schema({
    date: {
        type: String,
        reuired: true
    }
});

module.exports = mongoose.model('Calendar', CalendarSchema);
