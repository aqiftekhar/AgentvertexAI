const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const os = require("os");
require('dotenv').config();
const { execSync } = require("child_process");
const {
  speak,
  getLatestTranscript,
  transcribeFromMicStream,
} = require("./audioHandler");
const { generateGeminiResponse } = require("./vertexAI");

const HEADLESS_MODE = true;
const CHROME_PROFILE_DIR = {
  darwin: path.join(os.homedir(), process.env.CHROME_PROFILE_DARWIN),
  win32: path.join(os.homedir(), process.env.CHROME_PROFILE_WIN32),
  linux: path.join(os.homedir(), process.env.CHROME_PROFILE_LINUX),
};

const joinedMeetings = new Set();
const endedMeetings = new Set();

function killSoxProcesses() {
  try {
    const platform = os.platform();
    let cmd = "";

    if (platform === "win32") {
      // For Windows
      cmd = 'tasklist | findstr /I "sox.exe"';
      const result = execSync(cmd).toString();
      if (result) {
        console.log("🛑 Sox process found. Killing it...");
        execSync("taskkill /F /IM sox.exe");
      }
    } else {
      // For macOS/Linux
      cmd = "pgrep sox";
      const result = execSync(cmd).toString().trim();
      if (result) {
        console.log("🛑 Sox process found. Killing it...");
        execSync("pkill -9 sox");
      }
    }
  } catch (err) {
    if (err.status === 1) {
      console.log("✅ No sox process running.");
    } else {
      console.error("❌ Error checking/killing sox:", err.message);
    }
  }
}

killSoxProcesses();

async function getOngoingMeeting(csvFilePath) {
  const now = new Date();
  const meetings = [];

  return new Promise((resolve, reject) => {
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on("data", (row) => meetings.push(row))
      .on("end", () => {
        let matched = meetings.find((m) => {
          const startTime = new Date(`${m.date}T${m.starttime}`); // 💡 Changed to use ISO format
          const endTime = new Date(`${m.date}T${m.endtime}`); // 💡 Changed to use ISO format
          return now >= startTime && now <= endTime;
        });
        if (!matched) {
          const nextMeeting = meetings.find((m) => {
            const startTime = new Date(`${m.date} ${m.starttime}`);
            return now < startTime;
          });

          matched = nextMeeting ? nextMeeting : null;
        }
        matched ? resolve(matched) : null;
      });
  });
}

let meetingActive = false;
async function joinGoogleMeet(
  link,
  starttime,
  endTime,
  headless = HEADLESS_MODE
) {
  const userDataDir = CHROME_PROFILE_DIR[os.platform()];
  if (!userDataDir.includes(process.env.CHROME_USERNAME)) {
    console.error(
      '❗ Please replace "your_username" with your system username in meetingAgent.js'
    );
    return;
  }

  const browserURL = "http://127.0.0.1:9222";
  const browser = await puppeteer.connect({ browserURL, protocolTimeout: 0 });

  const page = await browser.newPage();

  setInterval(async () => {
    try {
      if (!page.isClosed()) {
        await page.evaluate(() => 1);
        console.log("Ping successful");
      } else {
        console.warn("Ping skipped: meeting is closed.");
      }
    } catch (err) {
      console.error("Ping failed", err);
    }
  }, 5 * 60 * 1000);

  await page.goto("https://myaccount.google.com");
  const isLoggedIn = await page.evaluate(
    () => !!document.querySelector('a[href*="SignOutOptions"]')
  );
  if (!isLoggedIn) {
    console.log(
      "❌ Not logged in. Please log in to Chrome with your Google account and restart."
    );
    await speak("You are not logged into Google. Please log in and restart.");
    await browser.close();
    return;
  }

  console.log("✅ Logged in. Navigating to meeting...");
  await page.goto(link, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 10000));

  try {
    const cameraBtnSelector = 'div[aria-label="Turn off camera"]';
    await page.waitForSelector(cameraBtnSelector, {
      timeout: 10000,
      visible: true,
    });
    const cameraBtn = await page.$(cameraBtnSelector);

    if (cameraBtn) {
      const isCameraOn = await page.evaluate(
        (el) => el.getAttribute("data-is-muted") === "false",
        cameraBtn
      );
      if (isCameraOn) {
        console.log("📷 Camera is ON. Turning it OFF...");
        await page.evaluate((el) => el.click(), cameraBtn);
      } else {
        console.log("✅ Camera is already OFF.");
      }
    } else {
      console.warn("⚠️ Camera button not found.");
    }
  } catch (err) {
    console.warn(
      "⚠️ Could not detect or interact with the camera button:",
      err.message
    );
  }

  const buttonLabels = [
    "Join now",
    "Ask to join",
    "Continue",
    "Join as Admin",
    "Switch here",
  ];
  let clicked = false;

  for (const label of buttonLabels) {
    const button = await page.evaluateHandle((text) => {
      return Array.from(document.querySelectorAll("button")).find(
        (btn) => btn.innerText.trim() === text
      );
    }, label);

    if (button) {
      await button.click();
      console.log(`✅ Clicked button with label: "${label}"`);
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    console.log("❌ No matching join button found.");
  }

  const dismissLabels = ["Got it", "Dismiss", "Close", "Cancel", "Ok"];
  for (const label of dismissLabels) {
    try {
      const dismissed = await page.evaluate((label) => {
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const btn of buttons) {
          if (btn.innerText.trim() === label) {
            btn.click();
            return true;
          }
        }
        return false;
      }, label);

      if (dismissed) {
        console.log(`ℹ️ Dismissed popup with label: "${label}"`);
        break;
      }
    } catch (err) {
      console.log(`⚠️ Error dismissing "${label}": ${err.message}`);
    }
  }

  function getMeetingDurationInMinutes(startTime, endTime) {
    const [startH, startM] = startTime.split(":").map(Number);
    const [endH, endM] = endTime.split(":").map(Number);
    const start = new Date(0, 0, 0, startH, startM);
    const end = new Date(0, 0, 0, endH, endM);
    const diff = (end - start) / 60000;
    return diff < 0 ? diff + 1440 : diff;
  }

  async function admitUserIfPopupAppears(page) {
    try {
      const clicked = await page.evaluate(() => {
        const span = [...document.querySelectorAll("span")].find(
          (el) => el.textContent.trim() === "Admit"
        );

        if (span) {
          const button = span.closest("button") || span.parentElement;

          if (button) {
            button.click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        console.log('🚪 "Admit" popup appeared. Clicking...');
        return true;
      }
    } catch (err) {
      console.log("⚠️ Admit user popup not found:", err.message);
    }

    return false;
  }

  meetingActive = true;
  admittedOnce = false;
  const autoAdmitParticipants = async (page, startTime, endTime) => {
    let intervalId = null;
    let aloneStartTime = null;
    const meetingDuration = getMeetingDurationInMinutes(startTime, endTime);
    const waitDuration = meetingDuration > 15 ? 15 * 60 * 1000 : 0;

    const checkParticipants = async () => {
      const now = new Date();

      const [endHour, endMin] = endTime.split(":").map(Number);
      const endMeetingTime = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        endHour,
        endMin
      );

      const participantCount = await getParticipantCount(page);
      console.log(`👥 Participants: ${participantCount}`);
      console.log(`End Meeting Time: ${endMeetingTime}`);

      if (now >= endMeetingTime) {
        console.log("⏱️ Scheduled end time reached. Ending meeting...");
        clearInterval(intervalId);
        await cleanupAfterMeeting(page, link);
        return;
      }

      if (participantCount >= 2) {
        console.log("✅ Enough participants. Continue meeting.");
        clearInterval(intervalId);
        return;
      }

      if (aloneStartTime === null && participantCount === 1) {
        aloneStartTime = Date.now();
        console.log("⌛ Waiting for another participant...");
      }

      if (participantCount === 1) {
        const aloneTime = Date.now() - aloneStartTime;

        if (waitDuration > 0 && aloneTime >= waitDuration) {
          console.log(
            `🕒 15-minute wait over. No second participant. Ending meeting.`
          );
          clearInterval(intervalId);
          if (!page.isClosed()) await page.close();
          return;
        }

        if (meetingDuration <= 15 && now >= endMeetingTime) {
          console.log(
            `🕒 Short meeting with no second participant. Ending at endtime.`
          );
          clearInterval(intervalId);
          if (!page.isClosed()) await page.close();
          return;
        }
      }
    };

    intervalId = setInterval(checkParticipants, 1000);
  };

  async function getParticipantCount(page) {
    try {
      if (page.isClosed()) return 0;

      const count = await page.evaluate(() => {
        const peopleButton = document.querySelector(
          'button[aria-label="People"]'
        );
        if (!peopleButton) return 0;

        const parent = peopleButton.closest(".r6xAKc") || document.body;
        const countDiv = parent.querySelector(".uGOf1d");

        const text = countDiv?.textContent?.trim() || "";
        const num = parseInt(text, 10);
        return isNaN(num) ? 1 : num;
      });

      console.log(`👥 Detected participants: ${count}`);
      return count;
    } catch (err) {
      console.error("⚠️ Failed to get participant count:", err.message);
      return 1;
    }
  }

  async function monitorParticipants(page, onMeetingEndCallback, endTime) {
    let participantCheckInterval = null;
    let aloneStartTime = null;
    let hadMultipleParticipants = false;

    participantCheckInterval = setInterval(async () => {
      const count = await getParticipantCount(page);
      console.log(`👥 Participants: ${count}`);

      const [hours, minutes] = endTime.split(":");
      const now = new Date();
      const endMeetingTime = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        parseInt(hours),
        parseInt(minutes)
      );

      console.log("End Meeting Time:", endMeetingTime);
      if (now >= endMeetingTime && !hadMultipleParticipants) {
        console.log("⏱️ Scheduled end time reached. Ending meeting...");
        clearInterval(participantCheckInterval);
        await cleanupAfterMeeting(page, link);
        return;
      }

      if (count === 1 && !hadMultipleParticipants) {
        const admitted = await admitUserIfPopupAppears(page);
        if (admitted) {
          admittedOnce = true;
          console.log(
            "✅ User admitted. Skipping further admit checks for this call."
          );
        }
        if (!aloneStartTime) {
          aloneStartTime = Date.now();
          console.log(
            "🕒 Only agent in the meeting. Starting 15-minute wait..."
          );
        } else if (Date.now() - aloneStartTime >= 15 * 60 * 1000) {
          console.log(
            "⏱️ 15 minutes passed with only one participant. Ending meeting..."
          );
          clearInterval(participantCheckInterval);
          await cleanupAfterMeeting(page, link);
        }
      } else if (count >= 2) {
        aloneStartTime = null;
        hadMultipleParticipants = true;

        const [endHour, endMinute] = endTime.split(":").map(Number);
        const now = new Date();
        const endDateTime = new Date();
        endDateTime.setHours(endHour, endMinute, 0, 0);

        const meetingEnded = now >= endDateTime;

        if (meetingEnded) {
          await speak(
            "Thanks for the discussion. I have another call scheduled. Have a great day ahead!"
          );
          clearInterval(participantCheckInterval);
          await cleanupAfterMeeting(page, link);
          return;
        }
      } else if (count === 1 && hadMultipleParticipants) {
        console.log(
          "🚪 Other participant left. Waiting for a moment before ending meeting..."
        );
        clearInterval(participantCheckInterval);
        await cleanupAfterMeeting(page, link);
      }
    }, 10000);
  }

  console.log("🎤 In meeting. AI assistant activated...");

  await autoAdmitParticipants(page, starttime, endTime);
  monitorParticipants(
    page,
    async () => {
      console.log("📤 Meeting ended due to participant logic.");
      await cleanupAfterMeeting(page, link);
    },
    endTime
  );

  let greeted = false;
  while (true) {
    if (page.isClosed()) {
      console.warn("🛑 Page was closed. Exiting loop.");
      break;
    }
    const count = await getParticipantCount(page);
    if (count >= 2) {
      if (!greeted) {
        console.log("👋 Participant 2 joined. Greeting them...");
        await speak("Hello, welcome to the meeting. How can I help you today?");
        greeted = true;
      }
      break;
    } else {
      console.log("⌛ Waiting for another participant...");
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
  console.log("🎤 Assistant active. Starting conversation...");
  const conversationLog = [];
  let summary = "";

  let aloneStartTime = null;
  console.log("I am outside loop");
  //transcribeFromMicStream();
  while (meetingActive) {
    const count = await getParticipantCount(page);
    if (count === 0) return;

    if (count < 2) {
      console.log(
        "🚪 Not enough participants to engage in conversation. Waiting..."
      );
      if (!aloneStartTime) {
        aloneStartTime = Date.now();
      } else {
        const elapsed = (Date.now() - aloneStartTime) / 1000;
        if (elapsed >= 120) {
          console.log(
            "⏳ Participant did not return within 2 minutes. Exiting loop..."
          );
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10000));
      continue;
    }

    try {
      const input = await transcribeFromMicStream();
      if (!input) continue;
      console.log("User  :", input);
      conversationLog.push({ role: "user", content: input });
      const response = await generateGeminiResponse(input);
      console.log("Gemini:", response);
      conversationLog.push({ role: "agent", content: response });
      await speak(response);
      if (input.toLowerCase().includes("end meeting")) break;
    } catch (err) {
      console.error("⚠️ Error during transcription:", err.message);
      await speak("I did not catch that. Could you please repeat?");
      // Grace period before reactivating listening
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait for 10 seconds
      // Continue listening after the grace period
      continue; 
    }
  }

  // 💡 Create the summary after the meeting ends
  const summaryPrompt = `Summarize the following meeting:\n${conversationLog
    .map((msg) => `${msg.role}: ${msg.content}`)
    .join("\n")}`;
  summary = await generateGeminiResponse(summaryPrompt); // 💡 Generate summary from conversation log
  // 💡 Get current date and time for file naming
  const now = new Date();
  const dateStartTime = now.toISOString().replace(/[:.]/g, "-").slice(0, 19); // Format: YYYY-MM-DDTHH-MM-SS
  const endTimeFormatted = now.toISOString().replace(/[:.]/g, "-").slice(0, 19); // Format: YYYY-MM-DDTHH-MM-SS
  // 💡 Create the summary file
  const summaryPath = path.join(
    __dirname,
    `../data/${dateStartTime}-${endTimeFormatted}-summary.txt`
  );
  fs.writeFileSync(summaryPath, summary); // 💡 Write summary to file
  console.log("📝 Summary saved:", summaryPath);
  // 💡 Create the conversation log file
  const logPath = path.join(
    __dirname,
    `../data/${dateStartTime}-${endTimeFormatted}-conversation-log.json`
  );
  fs.writeFileSync(logPath, JSON.stringify(conversationLog, null, 2)); // 💡 Write conversation log to file
  console.log("📜 Conversation log saved:", logPath);

  //await page.close();
}

async function onMeetingEndCallback(link) {
  console.log("📤 Meeting ended due to participant logic.");
  endedMeetings.add(link);
}

async function cleanupAfterMeeting(page, link) {
  meetingActive = false;
  if (!page.isClosed()) {
    try {
      await page.close();
      console.log("🧹 Cleaned up after meeting.");
    } catch (err) {
      console.warn(
        "⚠️ Failed to close page (possibly already closed):",
        err.message
      );
    } finally {
      meetingActive = false;
    }
  }
  await onMeetingEndCallback(link);
}

async function startAgent() {
  const csvPath = path.join(__dirname, "../data/meetings.csv");
  const now = new Date();

  const readMeetings = () => {
    return new Promise((resolve, reject) => {
      const meetings = [];
      fs.createReadStream(csvPath)
        .pipe(csv())
        .on("data", (row) => meetings.push(row))
        .on("end", () => resolve(meetings))
        .on("error", reject);
    });
  };

  const getTodayMeetings = async () => {
    const meetings = await readMeetings();
    const today = new Date().toLocaleDateString("en-CA");
    return meetings
      .filter((m) => m.date === today)
      .sort((a, b) => {
        const aTime = new Date(`${a.date}T${a.starttime}`);
        const bTime = new Date(`${b.date}T${b.starttime}`);
        return aTime.getTime() - bTime.getTime();
      });
  };

  const scheduleNextMeeting = async () => {
    const meetings = await getTodayMeetings();
    const now = new Date();

    for (const meeting of meetings) {
      const startDateTime = new Date(`${meeting.date}T${meeting.starttime}`);
      const endDateTime = new Date(`${meeting.date}T${meeting.endtime}`);

      if (endedMeetings.has(meeting.link)) continue;

      if (now > endDateTime) continue;

      if (meetingActive) {
        console.log("Meeting is currently active. Skipping scheduling.");
        return;
      }

      const delay = Math.max(startDateTime.getTime() - now.getTime(), 0);

      console.log(
        `🗓️ Next meeting at ${meeting.starttime} scheduled in ${Math.round(
          delay / 1000
        )} seconds.`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));

      console.log(`🚪 Joining meeting: ${meeting.link}`);
      if (endedMeetings.has(meeting.link)) {
        //console.log("❌ This meeting was previously ended. Skipping rejoin.");
        return;
      }
      meetingActive = true;
      await joinGoogleMeet(meeting.link, meeting.starttime, meeting.endtime);

      const meetingDuration = endDateTime.getTime() - new Date().getTime();
      await new Promise((resolve) => setTimeout(resolve, meetingDuration));

      meetingActive = false;
      console.log(
        `✅ Meeting at ${meeting.starttime} completed. Checking for next...`
      );

      await scheduleNextMeeting();
      break;
    }
  };

  await scheduleNextMeeting();

  fs.unwatchFile(csvPath);

  fs.watchFile(csvPath, { interval: 500 }, (curr, prev) => {
    console.log(
      `[${new Date().toLocaleTimeString()}] meetings.csv updated. Rechecking schedule...`
    );
    if (!meetingActive) scheduleNextMeeting();
  });
}

module.exports = { startAgent };
