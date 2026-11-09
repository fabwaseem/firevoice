import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "system" | "light" | "dark";

export interface Settings {
  serverUrl: string;
  token: string;
  theme: Theme;
  /** Default output format for Speak renders */
  format: "mp3" | "wav" | "flac" | "ogg" | "opus" | "m4a";
  /** Stream renders sentence by sentence instead of waiting for the full file */
  streamByDefault: boolean;
  /** Auto-play finished renders */
  autoPlay: boolean;
  /** Show engine parameter panel expanded */
  showAdvanced: boolean;
  sidebarCollapsed: boolean;
  /** Desktop app: start the bundled/local backend with the app and stop it on exit */
  manageBackend: boolean;
  /** The first-run welcome (GPU check, engine, test render) was completed or skipped */
  onboarded: boolean;
  setServerUrl: (v: string) => void;
  setToken: (v: string) => void;
  setTheme: (v: Theme) => void;
  set: (patch: Partial<Settings>) => void;
}

export const DEFAULT_SERVER = "http://127.0.0.1:8787";

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      serverUrl: DEFAULT_SERVER,
      token: "",
      theme: "system",
      format: "mp3",
      streamByDefault: true,
      autoPlay: true,
      showAdvanced: false,
      sidebarCollapsed: false,
      manageBackend: true,
      onboarded: false,
      setServerUrl: (serverUrl) => set({ serverUrl: serverUrl.replace(/\/+$/, "") || DEFAULT_SERVER }),
      setToken: (token) => set({ token }),
      setTheme: (theme) => set({ theme }),
      set: (patch) => set(patch),
    }),
    { name: "firevoice.settings", version: 1 },
  ),
);

/** Apply the theme to <html data-theme>. Called from the shell on mount and on change. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = theme === "system" ? (prefersDark ? "dark" : "light") : theme;
  root.dataset.theme = resolved;
}
