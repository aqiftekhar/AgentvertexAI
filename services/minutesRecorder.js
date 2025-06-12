const fs = require('fs');
const path = require('path');

function saveTranscript(log, filename) {
  const filePath = path.join('./output/minutes/', filename + '_log.json');
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
  return filePath;
}

function saveSummary(text, filename) {
  const filePath = path.join('./output/minutes/', filename + '_summary.txt');
  fs.writeFileSync(filePath, text);
  return filePath;
}

module.exports = { saveTranscript, saveSummary };
