# ProRes Converter

A drag-and-drop video converter that outputs **Apple ProRes 422** QuickTime files matching Adobe Premiere's AVCHD 1080p30 export specs. Non-16:9 source material is automatically letterboxed or pillarboxed — no content is ever cropped.

## Output Specifications

| Setting | Value |
|---------|-------|
| Container | QuickTime (.mov) |
| Video Codec | Apple ProRes 422 (Standard, profile 2) |
| Frame Size | 1920 × 1080 px |
| Frame Rate | 29.97 fps (30000/1001) |
| Pixel Format | YUV 4:2:2 10-bit |
| Audio Codec | Uncompressed PCM signed 24-bit LE |
| Sample Rate | 48 000 Hz |
| Channels | Stereo |

---

## Option A: Run as a Mac Desktop App (Recommended)

Build a native `.app` / `.dmg` that bundles everything — no Docker, no terminal commands for end users.

### Prerequisites (one-time)

1. **Node.js 20+** — download from [nodejs.org](https://nodejs.org/) or install via Homebrew: `brew install node`
2. **pnpm** — install with `npm install -g pnpm`

### Build the App

```bash
git clone https://github.com/matthewstraub/prores-converter.git
cd prores-converter
pnpm install
bash scripts/build-mac.sh
```

The script will:
1. Download static FFmpeg binaries for your Mac architecture (Apple Silicon or Intel)
2. Build the web app (Vite frontend + Express server)
3. Package everything into a `.dmg` in the `release/` directory

Open the `.dmg`, drag **ProRes Converter** to your Applications folder, and double-click to launch.

### Development Mode (Electron)

```bash
pnpm install
pnpm build
pnpm electron:dev
```

---

## Option B: Run with Docker

Run the converter locally using Docker — no Node.js installation needed.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (free)

### Run

```bash
git clone https://github.com/matthewstraub/prores-converter.git
cd prores-converter
docker build -t prores-converter .
docker run -p 3000:3000 prores-converter
```

Open [http://localhost:3000](http://localhost:3000) in your browser and drag in a video.

---

## Option C: Deploy to Render.com

A `Dockerfile` and `render.yaml` are included for one-click deployment to [Render.com](https://render.com).

1. Push this repo to GitHub
2. Create a new **Web Service** on Render, connect the repo
3. Render auto-detects the Dockerfile — select **Standard** plan or higher (video conversion needs ≥ 2 GB RAM)
4. Deploy

> **Tip:** Suspend the service from Render's dashboard when not in use — billing is prorated to the second.

---

## Project Structure

```
electron/           ← Electron main process + build config
  main.cjs          ← Electron entry point
  build-resources/  ← App icons and assets
scripts/
  build-mac.sh      ← macOS build script
server/
  converter.ts      ← FFmpeg conversion logic
  videoRoutes.ts    ← Upload, status, and download API
client/src/
  pages/Home.tsx    ← Drag-and-drop UI
Dockerfile          ← Docker build for server deployment
render.yaml         ← Render.com blueprint
```

---

## How It Works

1. **Upload** — The video is uploaded to the server via a multipart form POST.
2. **Probe** — `ffprobe` reads the source resolution, frame rate, and audio streams.
3. **Convert** — `ffmpeg` transcodes using the `prores_ks` encoder (profile 2 = standard ProRes 422), scales to fit 1920×1080 with black padding if needed, and encodes audio as uncompressed PCM 24-bit at 48 kHz.
4. **Download** — The converted `.mov` file is streamed back to the browser with range-request support for large files.

---

## License

MIT
