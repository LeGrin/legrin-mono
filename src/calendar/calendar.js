const fs = require('fs');
const readline = require('readline');
const {google} = require('googleapis');
const { promisify } = require('util')


const readFileAsync = promisify(fs.readFile)
const writeFileAsync = promisify(fs.writeFile)

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const TOKEN_PATH = './src/calendar/token.json';

init = async() => {
  var creds = await readFileAsync('./src/calendar/credentials.json');
  return await authorize(JSON.parse(creds));

}

// Load client secrets from a local file.


/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 */
authorize = async (credentials) => {
  const {client_secret, client_id, redirect_uris} = credentials.installed;
  console.log('1');

  const oAuth2Client = new google.auth.OAuth2(
      client_id, client_secret, redirect_uris[0]);
      console.log('2');

  // Check if we have previously stored a token.
  
  let token = '';
  try {
    console.log('3');

    token = await readFileAsync(TOKEN_PATH);
    console.log('4');

    oAuth2Client.setCredentials(JSON.parse(token));
    console.log('5');

  } catch (err) {
    token = await getAccessToken(oAuth2Client, token);
    oAuth2Client.setCredentials(token);
  }
  return oAuth2Client;
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
function getAccessToken(oAuth2Client, token) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', async (code) => {
    rl.close();
    token = await oAuth2Client.getToken(code);
    await writeFileAsync(TOKEN_PATH, JSON.stringify(token));
    oAuth2Client.setCredentials(token);
  });
}

/**
 * Lists the next 10 events on the user's primary calendar.
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
module.exports.addEvents = async (amount) => {
  let auth = await init();
  console.log(JSON.stringify(auth));
  console.log('6');

  const calendar = google.calendar({version: 'v3', auth});
  console.log('7');

  // Refer to the Node.js quickstart on how to setup the environment:
  // https://developers.google.com/calendar/quickstart/node
  // Change the scope to 'https://www.googleapis.com/auth/calendar' and delete any
  // stored credentials.

  var event = {
    'summary': `💶${amount}`,
    'location': '800 Howard St., San Francisco, CA 94103',
    'description': `💶${amount}`,
    'start': {
      'date': '2020-01-24',
      'timeZone': 'Europe/Kiev'
    },
    'end': {
      'date': '2020-01-24',
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

  console.log('8');

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
  });
}