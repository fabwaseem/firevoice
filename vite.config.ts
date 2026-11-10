import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;
const root = fileURLToPath(new URL(".", import.meta.url));

/** Dev server only: says which checkout it serves, so `tauri dev` never reuses another copy's server (scripts/dev-ui.mjs). */
const whoami = {
  name: "firevoice-whoami",
  configureServer(server: { middlewares: { use: (path: string, fn: (req: unknown, res: { setHeader: (k: string, v: string) => void; end: (b: string) => void }) => void) => void } }) {
    server.middlewares.use("/__firevoice_dev", (_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ root }));
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), whoami],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Loaded from disk inside the desktop shell, so one larger bundle is fine.
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      // two pages: the app, and the small dictation window that floats over other programs
      input: { main: fileURLToPath(new URL("./index.html", import.meta.url)), overlay: fileURLToPath(new URL("./overlay.html", import.meta.url)) },
      // Release builds name their files by content hash only, so the file names say nothing about the code inside.
      output: process.env.TAURI_ENV_DEBUG
        ? undefined
        : { entryFileNames: "assets/[hash].js", chunkFileNames: "assets/[hash].js", assetFileNames: "assets/[hash][extname]" },
    },
  },
});
