const fs = require('fs');
const csv = require('csv-parser');

async function readCSV(meetingCsvPath) {
  const meetings = [];
  return new Promise((resolve, reject) => {
    fs.createReadStream(meetingCsvPath)
      .pipe(csv())
      .on('data', (data) => {
        meetings.push(data);
      })
      .on('end', () => {
        resolve(meetings);
      })
      .on('error', (err) => {
        reject('Error reading CSV file: ' + err);
      });
  });
}

async function findMeeting(meetings, currentTime) {
  const now = new Date(currentTime);
  for (let meeting of meetings) {
    const meetingTime = new Date(meeting.date + ' ' + meeting.time); // Assumes 'date' and 'time' are in the CSV
    if (meetingTime.getTime() === now.getTime()) {
      return meeting;
    }
  }
  throw new Error('No meeting found for the current time.');
}

module.exports = { readCSV, findMeeting };
