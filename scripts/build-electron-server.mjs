/**
 * Build a fully self-contained server bundle for Electron.
 * Unlike the normal build (--packages=external), this inlines ALL dependencies
 * so the packaged Electron app doesn't need node_modules.
 */
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

await build({
  entryPoints: [path.join(projectRoot, "server/_core/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: path.join(projectRoot, "dist-electron"),
  target: "node20",
  // Bundle everything EXCEPT Node.js built-in modules
  packages: "bundle",
  external: [
    // Node.js built-ins that are available in Electron's Node runtime
    "node:*",
    // Vite is only used in dev mode, not needed in production
    "vite",
    "@tailwindcss/vite",
    "@vitejs/plugin-react",
    // These are dev-only and won't be needed at runtime
    "vite-plugin-manus-runtime",
    "@builder.io/vite-plugin-jsx-loc",
    // Native modules that can't be bundled
    "fsevents",
  ],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  // Handle the dynamic require pattern
  banner: {
    js: `
import { createRequire } from 'module';
import { fileURLToPath as _fileURLToPath } from 'url';
import { dirname as _dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = _fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);
`,
  },
  logLevel: "info",
  minify: false, // Keep readable for debugging
  sourcemap: false,
});

console.log("Electron server bundle built successfully in dist-electron/");
