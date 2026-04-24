/**
 * electron-builder configuration for ProRes Converter.
 *
 * The build process:
 * 1. `pnpm build` compiles the Vite frontend into dist/public/
 * 2. `node scripts/build-electron-server.mjs` creates a self-contained server bundle in dist-electron/
 * 3. The frontend is copied into dist-electron/public/
 * 4. electron-builder packages the Electron shell + dist-electron/ + ffmpeg binaries into a .app/.dmg
 */
module.exports = {
  appId: "com.proresconverter.app",
  productName: "ProRes Converter",
  directories: {
    output: "release",
    buildResources: "electron/build-resources",
  },
  files: [
    "electron/main.cjs",
    "electron/server-entry.cjs",
    "!node_modules/**/*",
    "!client/**/*",
    "!server/**/*",
    "!drizzle/**/*",
    "!shared/**/*",
    "!patches/**/*",
    "!.manus-logs/**/*",
    "!.git/**/*",
  ],
  extraResources: [
    {
      from: "dist-electron",
      to: "server",
      filter: ["**/*"],
    },
  ],
  mac: {
    category: "public.app-category.video",
    icon: "electron/build-resources/icon.icns",
    target: [
      {
        target: "dmg",
        arch: ["universal"],
      },
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    darkModeSupport: true,
    extraResources: [
      {
        from: "electron/bin/mac/${arch}",
        to: "bin",
        filter: ["ffmpeg", "ffprobe"],
      },
    ],
  },
  dmg: {
    title: "ProRes Converter",
    contents: [
      {
        x: 130,
        y: 220,
      },
      {
        x: 410,
        y: 220,
        type: "link",
        path: "/Applications",
      },
    ],
  },
  // Don't try to publish anywhere
  publish: null,
};
