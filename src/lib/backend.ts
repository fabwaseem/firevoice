/** The managed backend (Tauri only). The app works against any FireVoice server; this only matters when the app runs
 * the backend itself (see src-tauri/src/backend.rs). */

/** HTTP contract versions this build of the app understands (the server reports its own in /health). */
export const SUPPORTED_API = { min: 6, max: 6 } as const;

export interface BackendInfo {
  mode: "custom" | "bundled" | "dev" | "none";
  python: string | null;
  ready: boolean;
  /** torch and every voice library are installed too (always true outside the bundled runtime) */
  full_ready: boolean;
  bundled_version: string | null;
  bundled_api_version: number | null;
  installed_version: string | null;
  running: boolean;
  pid: number | null;
  port: number | null;
  log_path: string;
  runtime_dir: string;
  setup_running: boolean;
  extras_running: boolean;
  /** No NVIDIA card: the runtime is the small CPU build */
  cpu_only?: boolean;
}

export interface SetupEvent {
  step: number;
  steps: number;
  message: string;
  status: "running" | "done" | "failed";
  error: string | null;
}

/** One thing the background setup fetches or does. Ids: "wheel:torch", "wheel:torchaudio", "libs", "check". */
export interface ExtrasItem {
  id: string;
  label: string;
  done: number;
  total: number;
  state: "waiting" | "active" | "done";
}

/** The background half of the setup (torch and the voice libraries), installed while the app is already usable. */
export interface ExtrasState {
  status: "" | "idle" | "running" | "done" | "failed";
  stage: "" | "download" | "install" | "check";
  message: string;
  error: string | null;
  items: ExtrasItem[];
  done_bytes: number;
  total_bytes: number;
  bytes_per_sec: number;
  /** 0..1 over the whole background setup */
  progress: number;
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
  finishSetup: () => call<void>("backend_finish_setup"),
  extrasStatus: () => call<ExtrasState>("backend_extras_status"),
  onExtras: async (cb: (e: ExtrasState) => void) => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<ExtrasState>("backend-extras", (e) => cb(e.payload));
  },
};

/** 1536 -> "1.5 KB", 2.56e9 -> "2.4 GB" (binary units, as the downloads report them) */
export function fmtBytes(n: number): string {
  if (!n || n < 0) return "0 MB";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i < 2 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
}

/** Seconds left for a download, as words ("about 3 min left"), or "" when unknown. */
export function fmtEta(left: number, perSec: number): string {
  if (!perSec || perSec < 1 || left <= 0) return "";
  const s = left / perSec;
  if (s < 50) return "less than a minute left";
  if (s < 60 * 60) return `about ${Math.max(1, Math.round(s / 60))} min left`;
  return `about ${(s / 3600).toFixed(1)} h left`;
}

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
