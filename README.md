# ProRes Converter

A native macOS desktop application that converts any video file to **Apple ProRes 422** QuickTime format. Drag and drop a video, and get a broadcast-ready `.mov` file matching Adobe Premiere's AVCHD 1080p30 export specifications.

Non-16:9 source material is automatically letterboxed or pillarboxed — no content is ever cropped.

---

## Download

Pre-built DMG installers are available on the [Releases](https://github.com/matthewstraub/prores-converter/releases) page:

| Mac Type | Download |
|----------|----------|
| **Apple Silicon** (M1 / M2 / M3 / M4) | `ProRes-Converter-*-arm64.dmg` |
| **Intel** | `ProRes-Converter-*-x64.dmg` |

Open the `.dmg`, drag **ProRes Converter** to your Applications folder, and double-click to launch.

> **Note:** On first launch, macOS may show a security warning because the app is not notarized. Right-click the app and select **Open**, then click **Open** in the dialog to bypass Gatekeeper.

---

## Output Specifications

Every conversion produces a file with these exact settings:

| Setting | Value |
|---------|-------|
| Container | QuickTime (.mov) |
| Video Codec | Apple ProRes 422 (Standard, profile 2) |
| Frame Size | 1920 x 1080 px |
| Frame Rate | 29.97 fps (30000/1001) |
| Pixel Format | YUV 4:2:2 10-bit |
| Audio Codec | Uncompressed PCM signed 24-bit LE |
| Sample Rate | 48 000 Hz |
| Channels | Stereo |

---

## How It Works

1. **Upload** — Drag and drop a video file (MP4, MOV, AVI, MKV, MTS, and more) onto the app window, or click to browse.
2. **Probe** — `ffprobe` reads the source resolution, frame rate, and audio streams.
3. **Convert** — `ffmpeg` transcodes using the `prores_ks` encoder (profile 2 = standard ProRes 422), scales to fit 1920x1080 with black padding if needed, and encodes audio as uncompressed PCM 24-bit at 48 kHz.
4. **Download** — The converted `.mov` file is saved and ready for download.

---

## Architecture

ProRes Converter is an **Electron** desktop application that bundles a full web stack:

```
┌──────────────────────────────────────────┐
│              Electron Shell              │
│  ┌────────────────────────────────────┐  │
│  │     React Frontend (Vite)          │  │
│  │     Drag-and-drop UI               │  │
│  └──────────────┬─────────────────────┘  │
│                 │ HTTP                    │
│  ┌──────────────▼─────────────────────┐  │
│  │     Express Server (bundled)       │  │
│  │     Upload, status, download API   │  │
│  └──────────────┬─────────────────────┘  │
│                 │ spawn                   │
│  ┌──────────────▼─────────────────────┐  │
│  │     FFmpeg / FFprobe (static)      │  │
│  │     Bundled in app resources       │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

The Electron main process starts an Express server in a forked child process, then loads the React frontend in a BrowserWindow. FFmpeg and FFprobe are bundled as static binaries with zero external dependencies — no Homebrew, no system installs required.

---

## Project Structure

```
.github/workflows/
  build-mac.yml           ← GitHub Actions CI/CD (builds DMGs on tag push)
electron/
  main.cjs                ← Electron main process (window, server lifecycle)
  server-entry.cjs        ← CJS bridge to import the ESM server bundle
  build-resources/        ← App icons (.icns)
scripts/
  build-mac.sh            ← Local macOS build script
  build-electron-server.mjs ← Bundles the Express server for Electron
server/
  converter.ts            ← FFmpeg conversion logic (probe, transcode)
  videoRoutes.ts          ← Upload, status, and download REST API
  routers.ts              ← tRPC procedures
  db.ts                   ← Database query helpers
client/src/
  pages/Home.tsx          ← Drag-and-drop converter UI
  App.tsx                 ← Routes and layout
electron-builder.config.cjs ← electron-builder packaging config
Dockerfile                ← Docker build for server-only deployment
render.yaml               ← Render.com deployment blueprint
package.json              ← Dependencies and scripts
```

---

## CI/CD Pipeline

The project uses **GitHub Actions** to automatically build and release macOS DMG installers.

### Trigger

The workflow runs when a version tag is pushed (e.g., `v1.0.3`), or can be triggered manually from the Actions tab.

### Build Matrix

Two parallel jobs run on `macos-latest`:

| Job | Architecture | Output |
|-----|-------------|--------|
| `build-mac (arm64)` | Apple Silicon | `ProRes Converter-*-arm64.dmg` |
| `build-mac (x64)` | Intel | `ProRes Converter-*.dmg` |

### Build Steps

1. **Checkout** — Clone the repository
2. **Setup** — Install Node.js 22 and pnpm
3. **Dependencies** — `pnpm install`
4. **FFmpeg** — Download static FFmpeg and FFprobe binaries from [descriptinc/ffmpeg-ffprobe-static](https://github.com/descriptinc/ffmpeg-ffprobe-static) (v6.1.2), ad-hoc codesign them for macOS
5. **Frontend** — `pnpm build` (Vite)
6. **Server bundle** — `node scripts/build-electron-server.mjs` creates a self-contained server bundle, then copies the frontend into it
7. **Package** — `npx electron-builder --mac --config electron-builder.config.cjs --{arch}` produces the `.dmg`
8. **Release** — Uploads the DMG to the GitHub Release (for tag pushes) or as a workflow artifact (for manual runs)

### Creating a Release

```bash
# 1. Bump version in package.json
# 2. Commit and push
git add -A && git commit -m "bump version to 1.0.x"
git push origin main

# 3. Create and push a tag
git tag v1.0.x
git push origin v1.0.x
```

The workflow will automatically build both DMGs and attach them to the release.

---

## Alternative Deployment Options

### Docker (Server Mode)

Run the converter as a web server — no Electron, no desktop UI chrome.

```bash
git clone https://github.com/matthewstraub/prores-converter.git
cd prores-converter
docker build -t prores-converter .
docker run -p 3000:3000 prores-converter
```

Open [http://localhost:3000](http://localhost:3000) in your browser and drag in a video.

### Render.com

A `Dockerfile` and `render.yaml` are included for one-click deployment to [Render.com](https://render.com).

1. Push this repo to GitHub
2. Create a new **Web Service** on Render, connect the repo
3. Render auto-detects the Dockerfile — select **Standard** plan or higher (video conversion needs at least 2 GB RAM)
4. Deploy

> **Tip:** Suspend the service from Render's dashboard when not in use — billing is prorated to the second.

---

## Local Development

### Prerequisites

- **Node.js 22+** — download from [nodejs.org](https://nodejs.org/) or install via Homebrew: `brew install node`
- **pnpm** — install with `npm install -g pnpm`
- **FFmpeg** — install with `brew install ffmpeg` (for local dev only; the packaged app bundles its own)

### Run in Development Mode

```bash
git clone https://github.com/matthewstraub/prores-converter.git
cd prores-converter
pnpm install
pnpm dev
```

This starts the Vite dev server with hot module replacement. Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build the Desktop App Locally

```bash
pnpm install
bash scripts/build-mac.sh
```

The script downloads static FFmpeg binaries for your architecture, builds the web app, bundles the server, and packages everything into a `.dmg` in the `release/` directory.

### Run Tests

```bash
pnpm test
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| v1.0.3 | 2026-04-24 | Fixed macOS traffic light overlap on title bar; bumped version in package.json so DMG filenames reflect the correct version |
| v1.0.2 | 2026-04-24 | Replaced dynamically-linked Homebrew FFmpeg with static binaries; separate arm64/x64 builds instead of universal; fixed "Library not loaded: libavdevice.62.dylib" crash |
| v1.0.1 | 2026-04-24 | Added self-contained server bundle build step for Electron packaging |
| v1.0.0 | 2026-04-14 | Initial release with GitHub Actions CI/CD |

---

## Supported Input Formats

The converter accepts any format that FFmpeg can decode, including:

MP4, MOV, AVI, MKV, WMV, FLV, WebM, M4V, MPG, MPEG, MTS, M2TS, 3GP, TS

---

## Known Limitations

- **macOS only** — The Electron desktop app targets macOS. The Docker/Render options work on any platform.
- **Not notarized** — The app is not signed with an Apple Developer certificate. Users must right-click and select "Open" on first launch.
- **Large files** — Files over 2 GB may encounter issues with the upload mechanism. For very large files, consider using the Docker deployment option.

---

## License

MIT
