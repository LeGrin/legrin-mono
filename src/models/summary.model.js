const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const SummarySchema = new Schema({
    date: {
        type: Number,
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
    },
    statements: {
        type: Array,
        required: true
    }
});

module.exports = mongoose.model('Summary', SummarySchema);
