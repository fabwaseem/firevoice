/** Required updates (Tauri only; see src-tauri/src/updater.rs). */
import { inTauri } from "./backend";

export interface UpdateCheck {
  status: "none" | "available" | "offline" | "skipped";
  current: string;
  version: string | null;
  notes: string | null;
  date: string | null;
  reason: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

/** Where people can download FireVoice by hand if updating in the app keeps failing. */
export const RELEASES_PAGE = "https://github.com/fabwaseem/firevoice-releases/releases/latest";

async function call<T>(cmd: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd);
}

export const updates = {
  check: (): Promise<UpdateCheck> =>
    inTauri() ? call<UpdateCheck>("update_check") : Promise.resolve({ status: "skipped", current: "", version: null, notes: null, date: null, reason: null }),
  /** Download, verify and install. On success the app closes and the new version starts, so this rarely returns. */
  install: () => call<void>("update_install"),
  onProgress: async (cb: (p: UpdateProgress) => void) => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<UpdateProgress>("update-progress", (e) => cb(e.payload));
  },
};
