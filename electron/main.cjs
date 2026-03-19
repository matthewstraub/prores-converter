const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");

let mainWindow = null;
let serverProcess = null;
let serverPort = 3000;

/**
 * Find an available port starting from the given port.
 */
function findAvailablePort(startPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, () => {
      server.close(() => resolve(startPort));
    });
    server.on("error", () => {
      resolve(findAvailablePort(startPort + 1));
    });
  });
}

/**
 * Get the path to the bundled FFmpeg binary.
 * In development, ffmpeg-static provides the path.
 * In production (packaged app), we look in the extraResources directory.
 */
function getFfmpegPath() {
  if (app.isPackaged) {
    const platform = process.platform;
    const arch = process.arch;
    const resourcesPath = process.resourcesPath;
    // ffmpeg and ffprobe are copied to extraResources/bin/
    return {
      ffmpeg: path.join(resourcesPath, "bin", "ffmpeg"),
      ffprobe: path.join(resourcesPath, "bin", "ffprobe"),
    };
  } else {
    // In development, use ffmpeg-static
    try {
      const ffmpegStatic = require("ffmpeg-static");
      const ffprobeStatic = require("ffprobe-static");
      return {
        ffmpeg: ffmpegStatic,
        ffprobe: ffprobeStatic.path,
      };
    } catch (e) {
      // Fall back to system ffmpeg
      return {
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
      };
    }
  }
}

/**
 * Start the Express server as a child process.
 */
async function startServer() {
  serverPort = await findAvailablePort(3000);

  const ffmpegPaths = getFfmpegPath();
  const serverScript = app.isPackaged
    ? path.join(process.resourcesPath, "server", "index.js")
    : path.join(__dirname, "..", "dist", "index.js");

  console.log(`Starting server on port ${serverPort}...`);
  console.log(`Server script: ${serverScript}`);
  console.log(`FFmpeg: ${ffmpegPaths.ffmpeg}`);

  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(serverPort),
    FFMPEG_PATH: ffmpegPaths.ffmpeg,
    FFPROBE_PATH: ffmpegPaths.ffprobe,
    // Disable DB/OAuth for standalone desktop mode
    ELECTRON_MODE: "true",
  };

  serverProcess = spawn("node", [serverScript], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: app.isPackaged ? process.resourcesPath : path.join(__dirname, ".."),
  });

  serverProcess.stdout.on("data", (data) => {
    console.log(`[Server] ${data.toString().trim()}`);
  });

  serverProcess.stderr.on("data", (data) => {
    console.error(`[Server] ${data.toString().trim()}`);
  });

  serverProcess.on("error", (err) => {
    console.error("Failed to start server:", err);
    dialog.showErrorBox(
      "Server Error",
      `Failed to start the conversion server: ${err.message}`
    );
  });

  serverProcess.on("exit", (code) => {
    console.log(`Server process exited with code ${code}`);
    serverProcess = null;
  });

  // Wait for the server to be ready
  await waitForServer(serverPort, 15000);
}

/**
 * Wait for the server to start accepting connections.
 */
function waitForServer(port, timeout) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    function tryConnect() {
      const socket = new net.Socket();

      socket.setTimeout(1000);

      socket.on("connect", () => {
        socket.destroy();
        resolve();
      });

      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - startTime > timeout) {
          reject(new Error("Server failed to start within timeout"));
        } else {
          setTimeout(tryConnect, 300);
        }
      });

      socket.on("timeout", () => {
        socket.destroy();
        if (Date.now() - startTime > timeout) {
          reject(new Error("Server failed to start within timeout"));
        } else {
          setTimeout(tryConnect, 300);
        }
      });

      socket.connect(port, "127.0.0.1");
    }

    tryConnect();
  });
}

/**
 * Create the main application window.
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: "ProRes Converter",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#0a0a0b",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// App lifecycle
app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
  } catch (err) {
    console.error("Failed to start:", err);
    dialog.showErrorBox(
      "Startup Error",
      `Failed to start ProRes Converter: ${err.message}\n\nPlease try restarting the app.`
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  // On macOS, quit the app when all windows are closed
  // (unlike typical macOS behavior, since this is a utility app)
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on("before-quit", () => {
  // Kill the server process when quitting
  if (serverProcess) {
    console.log("Shutting down server...");
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
});

app.on("will-quit", () => {
  if (serverProcess) {
    serverProcess.kill("SIGKILL");
    serverProcess = null;
  }
});
