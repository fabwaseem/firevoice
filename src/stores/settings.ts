import { create } from "zustand";
import { persist } from "zustand/middleware";
import { inTauri } from "@/lib/backend";

export type Theme = "system" | "light" | "dark";

export interface Settings {
  serverUrl: string;
  token: string;
  theme: Theme;
  /** Default output format for Speak renders */
  format: "mp3" | "wav" | "flac" | "ogg" | "opus" | "m4a";
  /** Auto-play finished renders */
  autoPlay: boolean;
  /** Show engine parameter panel expanded */
  showAdvanced: boolean;
  sidebarCollapsed: boolean;
  /** Desktop app: start the bundled/local backend with the app and stop it on exit */
  manageBackend: boolean;
  /** The first-run welcome (GPU check, engine, test render) was completed or skipped */
  onboarded: boolean;
  /** Play the soft soundtrack during the first-run setup */
  setupMusic: boolean;
  /** The guided tour of the app was finished or closed */
  tourDone: boolean;
  setServerUrl: (v: string) => void;
  setToken: (v: string) => void;
  setTheme: (v: Theme) => void;
  set: (patch: Partial<Settings>) => void;
}

export const DEFAULT_SERVER = "http://127.0.0.1:8787";

/**
 * Turn whatever the user typed into a usable server address: add http:// when the scheme is
 * missing, drop trailing slashes, and fall back to the default when it still is not a valid URL.
 */
export function normaliseServerUrl(raw: string | null | undefined): string {
  let v = (raw ?? "").trim().replace(/\/+$/, "");
  if (!v) return DEFAULT_SERVER;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = "http://" + v;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return DEFAULT_SERVER;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_SERVER;
  }
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      serverUrl: DEFAULT_SERVER,
      token: "",
      theme: "system",
      format: "mp3",
      autoPlay: true,
      showAdvanced: false,
      sidebarCollapsed: false,
      manageBackend: true,
      onboarded: false,
      setupMusic: true,
      tourDone: false,
      setServerUrl: (serverUrl) => set({ serverUrl: normaliseServerUrl(serverUrl) }),
      setToken: (token) => set({ token }),
      setTheme: (theme) => set({ theme }),
      set: (patch) => set(patch.serverUrl !== undefined ? { ...patch, serverUrl: normaliseServerUrl(patch.serverUrl) } : patch),
    }),
    {
      name: "firevoice.settings",
      version: 1,
      // a bad address saved by an older version must not break the app on launch
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Settings>;
        // the app always runs and talks to its own engine (older versions let you point it elsewhere or add a key)
        return { ...current, ...p, serverUrl: DEFAULT_SERVER, token: "", manageBackend: true };
      },
    },
  ),
);

/** Apply the theme to <html data-theme>. Called from the shell on mount and on change. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = theme === "system" ? (prefersDark ? "dark" : "light") : theme;
  root.dataset.theme = resolved;
  // the desktop window's title bar follows the app's theme, not only Windows' (null = follow the system)
  if (inTauri()) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme === "system" ? null : theme))
      .catch(() => undefined);
  }
}
