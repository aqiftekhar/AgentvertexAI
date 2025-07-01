const fs = require("fs");
const path = require("path");
const { PassThrough } = require("stream");
const { spawn } = require("child_process");
const fetch = require("node-fetch");
const textToSpeech = require("@google-cloud/text-to-speech");
const speech = require("@google-cloud/speech");
const {
  connectOBS,
  playAvatarVideo,
  hideAvatarVideo,
} = require("./obsHandler");

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

connectOBS();

async function speak(text) {
  try {
    const request = {
      input: { text },
      voice: { languageCode: "en-US", ssmlGender: "NEUTRAL" },
      audioConfig: { audioEncoding: "LINEAR16" },
    };

    const [response] = await clientTTS.synthesizeSpeech(request);
    const outputPath = path.resolve(__dirname, "../output.wav");

    fs.writeFileSync(outputPath, response.audioContent);
    console.log("🔊 TTS audio saved:", outputPath);

    await generateAvatarFromAudio(outputPath);

    await playAvatarVideo(); // Show & play in OBS
    await playAudio(outputPath);
    //setTimeout(() => hideAvatarVideo(), 4000); // Hide after 4 sec
  } catch (err) {
    console.error("❌ TTS Error:", err);
    throw err;
  }
}

async function playAudio(filePath) {
  return new Promise((resolve, reject) => {
    const play = spawn("play", [filePath], {
      stdio: ["ignore", "ignore", "inherit"],
    });

    play.on("close", resolve);
    play.on("error", reject);
  });
}

async function generateAvatarFromAudio(audioPath) {
  return new Promise((resolve, reject) => {
    const subprocess = spawn(
      "python",
      [
        "Wav2Lip/inference.py",
        "--checkpoint_path",
        "Wav2Lip/checkpoints/wav2lip.pth",
        "--face",
        path.resolve(__dirname, "../avatar.png"),
        "--audio",
        audioPath,
        "--outfile",
        path.resolve(__dirname, "../output.mp4"),
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          PATH: `/Users/aqdasiftekhar/miniconda3/envs/wav2lip/bin:${process.env.PATH}`,
        },
      }
    );

    subprocess.stdout.on("data", (data) =>
      console.log("[Wav2Lip]", data.toString())
    );
    // subprocess.stderr.on("data", (data) =>
    //   //console.error("[Wav2Lip ERROR]", data.toString())
    // );

    subprocess.on("exit", (code) => {
      if (code === 0) {
        console.log("🎥 Wav2Lip avatar video generated");
        resolve();
      } else {
        reject(new Error(`Wav2Lip exited with code ${code}`));
      }
    });
  });
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

    const silenceFilter = ["silence", "1", "0.1", "0.1%", "1", "3.0", "0.1%"];
    const sox = spawn(soxPath, [...soxArgs, ...silenceFilter], {
      stdio: ["ignore", "pipe", "inherit"],
    });

    sox.on("error", (err) => {
      console.error("SoX error:", err);
      releaseTranscriptionLock();
      reject(err);
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
          singleUtterance: false,
        },
      })
      .on("error", (err) => {
        console.error("STT error:", err);
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

    if (signal) {
      signal.addEventListener("abort", () => {
        console.warn("🛑 Transcription aborted");
        cleanup();
        reject(new Error("Transcription aborted"));
      });
    }

    const timeout = setTimeout(() => {
      if (signal?.aborted) return;
      console.warn("⚠️ Speech timeout");
      cleanup();
      reject(new Error("Speech timeout"));
    }, 50000);

    audioStream.pipe(recognizeStream);
  });
}

module.exports = {
  speak,
  transcribeFromMicStream,
};
