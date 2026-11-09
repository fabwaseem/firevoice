// Dev server entry for `pnpm tauri dev` (beforeDevCommand).
//
// Tauri needs the UI on a fixed port (1420). If this project's Vite is already running there
// (for example from `pnpm dev` in another terminal), reuse it instead of failing with
// "Port 1420 is already in use". Otherwise start Vite in this process, so there is no child
// process left behind when Tauri stops the dev command.
import { createServer } from "vite";

const PORT = 1420;
const ORIGIN = `http://localhost:${PORT}`;

async function ourViteIsRunning() {
  try {
    // /src/main.tsx only exists on this project's Vite, so a hit means "same app, already serving".
    const res = await fetch(`${ORIGIN}/src/main.tsx`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
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

if (await ourViteIsRunning()) {
  console.log(`[dev-ui] Reusing the FireVoice UI dev server already running at ${ORIGIN}`);
  // Stay alive so Tauri treats the dev command as running; it stops us on exit.
  setInterval(() => {}, 1 << 30);
} else if (await portTaken()) {
  console.error(
    `[dev-ui] Port ${PORT} is in use by something that is not the FireVoice UI.\n` +
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
