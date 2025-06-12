// const { startAgent } = require('./services/meetingAgent');
// startAgent();

const { startAgent } = require('./services/meetingAgent');

async function runAgent() {
  while (true) {
    try {
      await startAgent();
    } catch (error) {
      console.error('Agent encountered an error:', error);
      console.log('Restarting agent...');
      // Optionally, you can add a delay before restarting
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds delay
    }
  }
}

runAgent();

