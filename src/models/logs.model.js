const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const LogsSchema = new Schema({
    time: {
        type: Date,
        reuired: true
    },
    message: {
        type: String,
        required: true
    },
    payload: {
        type: String,
        required: true
    }
});

module.exports = mongoose.model('Logs', LogsSchema);
