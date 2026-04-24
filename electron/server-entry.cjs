/**
 * CJS entry point for the Express server when running inside Electron.
 * This file is forked by the Electron main process.
 * It dynamically imports the ESM server bundle.
 *
 * Environment variables expected:
 *   PORT, FFMPEG_PATH, FFPROBE_PATH, ELECTRON_MODE, NODE_ENV
 */

// The server bundle is ESM, so we use dynamic import()
const path = require("path");

async function startServer() {
  // Determine the server bundle path
  const serverPath = process.env.SERVER_BUNDLE_PATH;
  if (!serverPath) {
    console.error("SERVER_BUNDLE_PATH not set");
    process.exit(1);
  }

  try {
    // Dynamic import of the ESM server bundle
    // The server auto-starts when imported (it calls startServer() at the bottom)
    await import(`file://${serverPath}`);
  } catch (err) {
    console.error("Failed to load server bundle:", err);
    process.exit(1);
  }
}

startServer();
