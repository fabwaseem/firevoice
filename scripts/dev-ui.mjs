// Dev server entry for `pnpm tauri dev` (beforeDevCommand).
//
// Tauri needs the UI on a fixed port (1420). If this project's Vite is already running there
// (for example from `pnpm dev` in another terminal), reuse it instead of failing with
// "Port 1420 is already in use". Otherwise start Vite in this process, so there is no child
// process left behind when Tauri stops the dev command.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

const PORT = 1420;
const ORIGIN = `http://localhost:${PORT}`;

/** The folder the Vite on our port serves, when it is a FireVoice dev server that says so (vite.config.ts); else null. */
async function servedRoot() {
  try {
    const res = await fetch(`${ORIGIN}/__firevoice_dev`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json(); // any other server answers with a page, which is not JSON
    return typeof body?.root === "string" ? body.root : null;
  } catch {
    return null;
  }
}

async function portTaken() {
  try {
    await fetch(ORIGIN, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

const running = await servedRoot();
if (running && same(running, ROOT)) {
  console.log(`[dev-ui] Reusing the FireVoice UI dev server already running at ${ORIGIN}`);
  // Stay alive so Tauri treats the dev command as running; it stops us on exit.
  setInterval(() => {}, 1 << 30);
} else if (await portTaken()) {
  console.error(
    `[dev-ui] Port ${PORT} is in use by ${running ? `the FireVoice UI of another copy of the project (${running})` : "something that is not this project's FireVoice UI"}.\n` +
      `         Find it with:  netstat -ano | findstr :${PORT}   and stop that process.`,
  );
  process.exit(1);
} else {
  const server = await createServer();
  await server.listen();
  server.printUrls();
  const close = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
