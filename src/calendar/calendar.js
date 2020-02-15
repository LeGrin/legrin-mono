const fs = require('fs');
const readline = require('readline');
const {google} = require('googleapis');
const { promisify } = require('util');
const Statement = require('../models/statement.model');
const Calendar = require('../models/calendar.model');

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
let oAuth2Client;

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const TOKEN_PATH = './src/calendar/token.json';

module.exports.init = async() => {
  let timer = setInterval(calculateTodaysSummary, 5000);

  fs.readFile('src/calendar/credentials.json', (err, content) => {
    if (err) return console.log('Error loading client secret file:', err);
    // Authorize a client with credentials, then call the Google Calendar API.
    authorize(JSON.parse(content), listEvents);
  });
}

calculateTodaysSummary = async() => {
  var endofDay = new Date();
  if (new Date().getTime() > endofDay.getTime()) {
    var start = endofDay;
    start.setHours(0,0,0,0);
    start = start.getTime();

    var end = endofDay;
    end.setHours(23,59,59,999);
    end = end.getTime();

    let todaysSummary = (await Calendar.find())
    .filter(c => c.date == new Date(endofDay.setHours(0,0,0,0)).toDateString())[0];

    if (todaysSummary) {
      return;
    }

    var todaysStatements = (await Statement.find())
    .filter(st => st.data.statementItem.time*1000 < end 
        && st.data.statementItem.time*1000 > start
        && st.data.statementItem.amount < 0);
    
    const spend = todaysStatements.reduce(function (accumulator, item) {
        return accumulator + item.data.statementItem.amount;
        }, 0);
    const details = todaysStatements.reduce(function (accumulator, item) {
      return accumulator + `\n${item.data.statementItem.description.replace(/(\r\n|\n|\r)/gm, "") + ' : ' + -1*item.data.statementItem.amount/100}`;
      }, '');
      await addEvents(endofDay,-1*spend/100, details);
}
  //if(true) {
   
 // }

}

// Load client secrets from a local file.


/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 */
function authorize(credentials, callback) {
  const {client_secret, client_id, redirect_uris} = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
      client_id, client_secret, redirect_uris[0]);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) return getAccessToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

authorizeAsync = async () => {
  const credentials = JSON.parse(await readFileAsync('src/calendar/credentials.json'));
  const {client_secret, client_id, redirect_uris} = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
      client_id, client_secret, redirect_uris[0]);
  
  const token = await readFileAsync(TOKEN_PATH);
  oAuth2Client.setCredentials(JSON.parse(token))
  return oAuth2Client;
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
function getAccessToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error retrieving access token', err);
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) return console.error(err);
        console.log('Token stored to', TOKEN_PATH);
      });
      callback(oAuth2Client);
    });
  });
}

/**
 * Lists the next 10 events on the user's primary calendar.
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
function listEvents(auth) {
  const calendar = google.calendar({version: 'v3', auth});
  calendar.events.list({
    calendarId: 'dmhnmbi4hpshhn2o8op3te2roo@group.calendar.google.com',
    timeMin: (new Date()).toISOString(),
    maxResults: 10,
    singleEvents: true,
    orderBy: 'startTime',
  }, (err, res) => {
    if (err) return console.log('The API returned an error: ' + err);
    const events = res.data.items;
    if (events.length) {
      console.log('Upcoming 10 events:');
      events.map((event, i) => {
        const start = event.start.dateTime || event.start.date;
        console.log(`${start} - ${event.summary}`);
      });
    } else {
      console.log('No upcoming events found.');
    }
  });
}

/**
 * Lists the next 10 events on the user's primary calendar.
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
addEvents = async (date, amount, details) => {
  let auth = await authorizeAsync();

  const calendar = google.calendar({version: 'v3', auth});

  let dateParsed = date.getFullYear() + '-' + (date.getMonth()+1) + '-' +  date.getDate() ;
  var emojiAmount = '⚪⚪⚪';
  if (amount > 300) {
    emojiAmount = '🔵⚪⚪';
  }
  if (amount > 500) {
    emojiAmount = '🔵🔵⚪';
  }
  if (amount > 800) {
    emojiAmount = '🔵🔵🔵';
  }
  if (amount > 1000) {
    emojiAmount = '🔴⚪⚪';
  }
  if (amount > 3000) {
    emojiAmount = '🔴🔴⚪';
  }
  if (amount > 5000) {
    emojiAmount = '🔴🔴🔴';
  } 
  var event = {
    'summary': emojiAmount + ` 💶${amount}`,
    'location': '',
    'description': details,
    'start': {
      'date': dateParsed,
      'timeZone': 'Europe/Kiev'
    },
    'end': {
      'date': dateParsed,
      'timeZone': 'Europe/Kiev'
    },
    'recurrence': [
    ],
    'attendees': [
    ],
    'reminders': {
      'useDefault': false,
      'overrides': [
      ],
    },
  };

  calendar.events.insert({
    auth: auth,
    calendarId: 'dmhnmbi4hpshhn2o8op3te2roo@group.calendar.google.com',
    resource: event,
  }, function(err, event) {
    if (err) {
      console.log('There was an error contacting the Calendar service: ' + err);
      return;
    }
    console.log('Event created: %s', event.htmlLink);
    let newEvent = new Calendar({date : new Date(date.setHours(0,0,0,0)).toDateString()});
    newEvent.save();
  });
}