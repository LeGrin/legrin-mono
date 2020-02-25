const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');
const { promisify } = require('util');
const Statement = require('../models/statement.model');
const Calendar = require('../models/calendar.model');

const readFileAsync = promisify(fs.readFile);

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const TOKEN_PATH = __dirname + '/token.json';

module.exports.init = async () => {
  let timer = setInterval(calculateTodaysSummary, 5000);
  console.log(getLogDate());
  fs.readFile(__dirname + '/credentials.json', (err, content) => {
    if (err) return console.log(getLogDate() + 'Error loading client secret file:', err);
    authorize(JSON.parse(content), listEvents);
  });
};

getLogDate = () => {
	let date = new Date();
	return '[' + date.getFullYear().toString() +
      '-' +
      (date.getMonth() + 1).toString() +
      '-' +
      date.getDate().toString() + 
      ' ' + (date.getHours() > 9 ? date.getHours().toString() : '0' + date.getHours().toString()) +
      ':' + (date.getMinutes() > 9 ? date.getMinutes().toString() : '0' + date.getMinutes().toString()) +
      ':' + (date.getSeconds() > 9 ? date.getSeconds().toString() : '0' + date.getSeconds().toString()) + '] ';
}

calculateTodaysSummary = async () => {
  let endofDay = new Date(2020,01,24);
  endofDay.setHours(23, 59, 30, 0);
  if (new Date().getTime() > endofDay.getTime()) {
    let start = endofDay;
    start.setHours(0, 0, 0, 0);
    start = start.getTime();

    let end = endofDay;
    end.setHours(23, 59, 59, 999);
    end = end.getTime();

    let todaysSummary = (await Calendar.find()).filter(
      c => c.date === new Date(endofDay.setHours(0, 0, 0, 0)).toDateString()
    )[0];
    if (todaysSummary) {
      //return;
    }

    let date =
      endofDay.getFullYear() +
      '-' +
      (endofDay.getMonth() + 1) +
      '-' +
      endofDay.getDate();
    console.log(getLogDate() + 'Producing summary for ' + date);

    let todaysStatements = (await Statement.find()).filter(
      st =>
        st.data.statementItem.time * 1000 < end &&
        st.data.statementItem.time * 1000 > start &&
        st.data.statementItem.amount < 0
    );
    console.log(getLogDate() + 'Today was made ' + todaysStatements.length + ' operations');

    const spend = todaysStatements.reduce(function(accumulator, item) {
      return accumulator + item.data.statementItem.amount;
    }, 0);
    const details = todaysStatements.reduce(function(accumulator, item) {
      return (
        accumulator +
        `\n${getTransactionAmountEmojii(
          (-1 * item.data.statementItem.amount) / 100
        ) +
          getHoursAndMinutes(item.data.statementItem.time) +
          item.data.statementItem.description.replace(/(\r\n|\n|\r)/gm, '') +
          ' : ' +
          (-1 * item.data.statementItem.amount) / 100}`
      );
    }, '');
    console.log('with total amount of  ' + (-1 * spend) / 100);
    try {
      await addEvents(endofDay, (-1 * spend) / 100, details);
    } catch (ex)
    {
      console.log(getLogDate() + 'Failed to save event: ' + JSON.stringify(ex));
    }
  }
};

getTransactionAmountEmojii = amount => {
  if (amount < 500) return '✔️';
  if (amount < 1000) return '⚠️';
  if (amount > 1000) return '❗️';
};

getHoursAndMinutes = timeStampt => {
  let date = new Date(timeStampt * 1000);
  let hours = date.getHours() > 9 ? date.getHours() : '0' + date.getHours();
  let minutes =
    date.getMinutes() > 9 ? date.getMinutes() : '0' + date.getMinutes();
  return hours + ':' + minutes + ' ';
};

getTotalAmountEmoji = amount => {
  if (amount < 300) return '⚪⚪⚪';
  if (amount < 500) return '🔵⚪⚪';
  if (amount < 800) return '🔵🔵⚪';
  if (amount < 1000) return '🔵🔵🔵';
  if (amount < 3000) return '🔴⚪⚪';
  if (amount < 5000) return '🔴🔴⚪';
  return '🔴🔴🔴';
};

addEvents = async (date, amount, details) => {
  let auth = await authorizeAsync();

  const calendar = google.calendar({ version: 'v3', auth });

  let dateParsed =
    date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate();

  let event = {
    summary: getTotalAmountEmoji(amount) + ` 💶${amount}`,
    description: details,
    start: {
      date: dateParsed,
      timeZone: 'Europe/Kiev'
    },
    end: {
      date: dateParsed,
      timeZone: 'Europe/Kiev'
    }
  };

  calendar.events.insert(
    {
      auth: auth,
      calendarId: 'dmhnmbi4hpshhn2o8op3te2roo@group.calendar.google.com',
      resource: event
    },
    function(err, event) {
      if (err) {
        console.log(
          getLogDate() + 'There was an error contacting the Calendar service: ' + err
        );
        return;
      }
      console.log(getLogDate() + 'Event created: %s', event.htmlLink);
      let newEvent = new Calendar({
        date: new Date(date.setHours(0, 0, 0, 0)).toDateString()
      });
      newEvent.save();
    }
  );
};

function authorize(credentials, callback) {
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) return getAccessToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

authorizeAsync = async () => {
  const credentials = JSON.parse(
    await readFileAsync('src/calendar/credentials.json')
  );
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  const token = await readFileAsync(TOKEN_PATH);
  oAuth2Client.setCredentials(JSON.parse(token));
  return oAuth2Client;
};

function getAccessToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  rl.question('Enter the code from that page here: ', code => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error(getLogDate() + 'Error retrieving access token', err);
      oAuth2Client.setCredentials(token);
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), err => {
        if (err) return console.error(err);
        console.log('Token stored to', TOKEN_PATH);
      });
      callback(oAuth2Client);
    });
  });
}

function listEvents(auth) {
  const calendar = google.calendar({ version: 'v3', auth });
  calendar.events.list(
    {
      calendarId: 'dmhnmbi4hpshhn2o8op3te2roo@group.calendar.google.com',
      timeMin: new Date().toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime'
    },
    (err, res) => {
      if (err) return console.log(getLogDate() + 'The API returned an error: ' + err);
      const events = res.data.items;
      if (events.length) {
        console.log('Upcoming 10 events:');
        events.map((event, i) => {
          const start = event.start.dateTime || event.start.date;
          console.log(`${start} - ${event.summary}`);
        });
      } else {
        console.log(getLogDate() + 'Calendar api initialized');
      }
    }
  );
}
