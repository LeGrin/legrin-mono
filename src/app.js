const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const db_config = require('../config/db');
const https = require('https');
const http = require('http');
const fs = require('fs');

// Импортируем роуты.
const statement = require('./routes/statement.route');
const logs = require('./routes/logs.route');
const summary = require('./routes/summary.route');
const countdown = require('./routes/countdown.route');
const calendar = require('./calendar/calendar');

//calendar.addEvents(1200);

// Инициализируем express приложение.
const app = express();

// Устанавливаем соединение между mongoose и mongodb.
const mongoose = require('mongoose');
const mongoDB = process.env.MONGODB_URI || db_config.url;
console.log(mongoDB);
mongoose.connect(mongoDB, { useNewUrlParser: true }); 
mongoose.Promise = global.Promise;
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));

// Устанавливаем middleware обработчики.
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));
app.use(cors());

// Покдключаем роуты.
app.use('/statement', statement);
app.use('/logs', logs);
app.use('/summary', summary);
app.use('/countdown', countdown);

app.get('/counter', (req,res) => {
    res.render('index');
});
app.get('/button', (req,res) => {
    res.sendFile(__dirname + '/button.html');
});



var key = fs.readFileSync(__dirname + '/../selfsigned.key');
var cert = fs.readFileSync(__dirname + '/../selfsigned.crt');
var options = {
  key: key,
  cert: cert
};

var servers = https.createServer(options, app);

var server = http.createServer(app);

let port = 80;
server.listen(port, () => {
    console.log('Server is running on port ' + port)
});

servers.listen(443, () => {
    console.log("server starting on port : " + 3000)
  });
