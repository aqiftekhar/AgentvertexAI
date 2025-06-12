const { PassThrough } = require("stream");
const { spawn } = require("child_process");
const textToSpeech = require("@google-cloud/text-to-speech");
const speech = require("@google-cloud/speech");
require("dotenv").config();

const clientTTS = new textToSpeech.TextToSpeechClient();
const clientSTT = new speech.SpeechClient();
const soxPath = process.env.SOX_PATH || "sox";

const DEFAULT_MIC_DEVICE =
  process.env.DEFAULT_MIC_DEVICE ||
  (process.platform === "darwin" ? "BlackHole 2ch" : "default");

let isTranscribing = false;
const transcriptionQueue = [];

async function acquireTranscriptionLock() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (!isTranscribing) {
        isTranscribing = true;
        resolve();
      } else {
        transcriptionQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releaseTranscriptionLock() {
  isTranscribing = false;
  if (transcriptionQueue.length > 0) {
    const next = transcriptionQueue.shift();
    next();
  }
}

async function speak(text) {
  try {
    const request = {
      input: { text },
      voice: { languageCode: "en-US", ssmlGender: "NEUTRAL" },
      audioConfig: { audioEncoding: "LINEAR16" },
    };

    const [response] = await clientTTS.synthesizeSpeech(request);

    const play = spawn("play", ["-t", "wav", "-"], {
      stdio: ["pipe", "ignore", "inherit"],
    });

    play.stdin.write(response.audioContent);
    play.stdin.end();

    return new Promise((resolve) => {
      play.on("close", resolve);
    });
  } catch (err) {
    console.error("TTS Error:", err);
    throw err;
  }
}
async function transcribeFromMicStream(
  micDevice = DEFAULT_MIC_DEVICE,
  signal = null
) {
  await acquireTranscriptionLock();
  return new Promise((resolve, reject) => {
    const soxArgs = [
      "-t",
      process.platform === "darwin" ? "coreaudio" : "alsa",
      micDevice,
      "-r",
      "16000",
      "-c",
      "1",
      "-b",
      "16",
      "-e",
      "signed-integer",
      "-t",
      "raw",
      "-",
    ];

    // Optional silence filter (comment out if issues continue)
    const silenceFilter = ["silence", "1", "0.1", "0.1%", "1", "3.0", "0.1%"];

    const sox = spawn(soxPath, [...soxArgs, ...silenceFilter], {
      stdio: ["ignore", "pipe", "inherit"],
    });

    sox.on("error", (err) => {
      console.error("SoX process error:", err);
      releaseTranscriptionLock();
      reject(err);
    });

    sox.on("exit", (code, sig) => {
      if (code !== 0) {
        console.warn(
          `⚠️ SoX exited unexpectedly with code ${code}, signal ${sig}`
        );
      }
    });

    const audioStream = new PassThrough();
    sox.stdout.pipe(audioStream);

    const recognizeStream = clientSTT
      .streamingRecognize({
        config: {
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
          languageCode: "en-US",
          interimResults: false,
          singleUtterance: false, // ⬅️ prevents early cutoff
        },
      })
      .on("error", (err) => {
        console.error("STT streaming error:", err);
        cleanup();
        reject(err);
      })
      .on("data", (data) => {
        const result = data.results?.[0];
        const alt = result?.alternatives?.[0];

        if (result?.isFinal && alt?.transcript) {
          console.log("🎤 Transcription:", alt.transcript);
          cleanup();
          resolve(alt.transcript);
        }
      });

    const cleanup = () => {
      clearTimeout(timeout);
      sox.kill("SIGINT");
      recognizeStream.destroy();
      releaseTranscriptionLock();
    };

    // 🛑 Abort controller
    if (signal) {
      signal.addEventListener("abort", () => {
        console.warn("🛑 Transcription aborted by signal");
        cleanup();
        reject(new Error("Transcription aborted"));
      });
    }

    // ⏱ Timeout fallback
    const timeout = setTimeout(() => {
      if (signal?.aborted) return;
      console.warn("⚠️ Transcription timeout - no speech detected");
      cleanup();
      reject(new Error("Speech timeout"));
    }, 50000);

    audioStream.pipe(recognizeStream);
  });
}

module.exports = { speak, transcribeFromMicStream };
