const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const StatementSchema = new Schema({
    type: {
        type: String,
        reuired: true
    },
    data: {
        account: {
            type: String,
            require: true
        },
        statementItem:   {
            id: {
                type: String,
                require: true
            },
            time: {
                type: Number,
                require: true
            },
            description: {
                type: String,
                require: true
            },
            mcc: {
                type: Number,
                require: true
            },
            hold: {
                type: Boolean,
                require: true
            },
            amount: {
                type: Number,
                require: true
            },
            operationAmount: {
                type: Number,
                require: true
            },
            currencyCode: {
                type: Number,
                require: true
            },
            commissionRate: {
                type: Number,
                require: true
            },
            cashbackAmount: {
                type: Number,
                require: true
            },
            balance: {
                type: Number,
                require: true
            }
          }
    }
});

module.exports = mongoose.model('Statement', StatementSchema);


