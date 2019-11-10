const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const SummarySchema = new Schema({
    date: {
        type: Date,
        reuired: true
    },
    spend: {
        type: Number,
        required: true
    },
    limit: {
        type: Number,
        required: true
    },
    delta : {
        type: Number,
        required: true
    }
});

module.exports = mongoose.model('Summary', SummarySchema);
