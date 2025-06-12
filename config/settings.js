require('dotenv').config();

module.exports = {
  projectId: process.env.PROJECT_ID,
  googleCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  meetingCsvPath: './data/meetings.csv',
  outputDir: './output/minutes/',
  transcriptionDurationSec: 5,
  //geminiModel: 'gemini-2.5-pro-preview-05-06',
  geminiModel: 'gemini-2.0-flash-001',
};
