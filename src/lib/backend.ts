/** The managed backend (Tauri only). The app works against any FireVoice server; this only matters when the app runs
 * the backend itself (see src-tauri/src/backend.rs). */

/** HTTP contract versions this build of the app understands (the server reports its own in /health). */
export const SUPPORTED_API = { min: 2, max: 2 } as const;

export interface BackendInfo {
  mode: "custom" | "bundled" | "dev" | "none";
  python: string | null;
  ready: boolean;
  bundled_version: string | null;
  bundled_api_version: number | null;
  installed_version: string | null;
  running: boolean;
  pid: number | null;
  port: number | null;
  log_path: string;
  runtime_dir: string;
  setup_running: boolean;
}

export interface SetupEvent {
  step: number;
  steps: number;
  message: string;
  status: "running" | "done" | "failed";
  error: string | null;
}

export const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const backend = {
  info: () => call<BackendInfo>("backend_info"),
  start: (port?: number) => call<BackendInfo>("backend_start", { port }),
  stop: () => call<BackendInfo>("backend_stop"),
  logs: (lines = 300) => call<string>("backend_logs", { lines }),
  setup: () => call<void>("backend_setup"),
  onSetup: async (cb: (e: SetupEvent) => void) => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<SetupEvent>("backend-setup", (e) => cb(e.payload));
  },
};

/** The port of a server URL on this machine, or null when the URL points somewhere else (then the app never manages it). */
export function localPort(serverUrl: string): number | null {
  try {
    const u = new URL(serverUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
    return Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {
    return null;
  }
}

/** "ok", or why this server and this app cannot work together. */
export function apiCompat(apiVersion: number | undefined, minClient: number | undefined): "ok" | "server-too-old" | "app-too-old" {
  const v = apiVersion ?? 1; // servers before 1.1 do not report it
  if (v < SUPPORTED_API.min) return "server-too-old";
  if ((minClient ?? 1) > SUPPORTED_API.max) return "app-too-old";
  return "ok";
}
