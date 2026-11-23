/** App updates (Tauri only; see src-tauri/src/updater.rs). Optional: the user decides when to download and when to
 * install; nothing here blocks the app. */
import { inTauri } from "./backend";

export interface UpdateCheck {
  status: "none" | "available" | "offline" | "skipped";
  current: string;
  version: string | null;
  notes: string | null;
  date: string | null;
  reason: string | null;
}

/** The download, from the shell. */
export interface UpdateStatus {
  state: "" | "idle" | "downloading" | "ready" | "failed";
  version: string | null;
  downloaded: number;
  total: number | null;
  bytes_per_sec: number;
  error: string | null;
}

/** Where people can download FireVoice by hand if updating in the app keeps failing. */
export const RELEASES_PAGE = "https://github.com/fabwaseem/firevoice/releases/latest";

async function call<T>(cmd: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd);
}

export const updates = {
  check: (): Promise<UpdateCheck> =>
    inTauri() ? call<UpdateCheck>("update_check") : Promise.resolve({ status: "skipped", current: "", version: null, notes: null, date: null, reason: null }),
  /** Start the download in the background (returns at once; progress comes as events). */
  download: () => call<void>("update_download"),
  status: () => call<UpdateStatus>("update_status"),
  /** Install the downloaded update: the app closes and the new version starts, so this rarely returns. */
  install: () => call<void>("update_install"),
  onProgress: async (cb: (s: UpdateStatus) => void) => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<UpdateStatus>("update-progress", (e) => cb(e.payload));
  },
};
