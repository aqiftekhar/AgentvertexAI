const OBSWebSocket = require("obs-websocket-js").default;
const path = require("path");
require("dotenv").config();

const obs = new OBSWebSocket();

// Connect to OBS WebSocket
async function connectOBS() {
  try {
    await obs.connect(`ws://localhost:4455`, process.env.OBS_PASSWORD);
    console.log("✅ Connected to OBS WebSocket");
  } catch (err) {
    console.error("❌ OBS Connection Failed:", err.message);
  }
}

async function playAvatarVideo(sourceName = "AvatarVideo") {
  try {
    const videoPath = path.resolve(__dirname, "../output.mp4");

    console.log("🎬 Updating video source to:", videoPath);

    // Get the scene item ID
    const sceneItemId = await getSceneItemId(sourceName);

    // Disable the source to allow file refresh
    await obs.call("SetSceneItemEnabled", {
      sceneName: process.env.OBS_SCENE || "Scene",
      sceneItemId,
      sceneItemEnabled: false,
    });

    // Wait briefly to ensure OBS fully disables it
    await new Promise((res) => setTimeout(res, 300));

    // Update input path (OBS reloads the file)
    await obs.call("SetInputSettings", {
      inputName: sourceName,
      inputSettings: {
        local_file: videoPath,
      },
      overlay: true,
    });

    // Re-enable the source to trigger playback
    await obs.call("SetSceneItemEnabled", {
      sceneName: process.env.OBS_SCENE || "Scene",
      sceneItemId,
      sceneItemEnabled: true,
    });

    console.log(`✅ Avatar video now playing from: ${videoPath}`);

    // Optional: hide after a few seconds
    setTimeout(() => {
      hideAvatarVideo(sourceName);
    }, 6000); // Adjust if needed
  } catch (err) {
    console.error("❌ Failed to play avatar video:", err.message);
  }
}

// Hide the media source
async function hideAvatarVideo(sourceName = "AvatarVideo") {
  try {
    await obs.call("SetSceneItemEnabled", {
      sceneName: process.env.OBS_SCENE || "Scene",
      sceneItemId: await getSceneItemId(sourceName),
      sceneItemEnabled: false,
    });

    console.log(`🚫 Avatar video hidden on source: ${sourceName}`);
  } catch (err) {
    console.error("❌ Failed to hide avatar video:", err.message);
  }
}

// Get scene item ID by source name
async function getSceneItemId(sourceName) {
  const { sceneItems } = await obs.call("GetSceneItemList", {
    sceneName: process.env.OBS_SCENE || "Scene",
  });
  console.log(
    `🔎 Looking for source "${sourceName}" in scene items:`,
    sceneItems.map((i) => i.sourceName)
  );
  const item = sceneItems.find((i) => i.sourceName === sourceName);
  if (!item) throw new Error(`Source "${sourceName}" not found in OBS`);
  return item.sceneItemId;
}

module.exports = {
  connectOBS,
  playAvatarVideo,
  hideAvatarVideo,
};
