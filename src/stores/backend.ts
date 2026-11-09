import { create } from "zustand";
import { backend, inTauri, localPort, type BackendInfo, type SetupEvent } from "@/lib/backend";
import { useSettings } from "./settings";

type Phase = "idle" | "starting" | "needs-setup" | "needs-update" | "setting-up" | "failed";

interface BackendState {
  info: BackendInfo | null;
  phase: Phase;
  setup: SetupEvent | null;
  error: string | null;
  refresh: () => Promise<BackendInfo | null>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  runSetup: () => Promise<void>;
  set: (p: Partial<BackendState>) => void;
}

let unlisten: (() => void) | null = null;

export const useBackend = create<BackendState>()((set, get) => ({
  info: null,
  phase: "idle",
  setup: null,
  error: null,
  set: (p) => set(p),
  refresh: async () => {
    if (!inTauri()) return null;
    try {
      const info = await backend.info();
      set({ info });
      return info;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },
  start: async () => {
    const port = localPort(useSettings.getState().serverUrl) ?? 8787;
    set({ phase: "starting", error: null });
    try {
      // stays "starting" until /health answers (BackendManager watches that)
      set({ info: await backend.start(port) });
    } catch (e) {
      set({ phase: "failed", error: String(e) });
    }
  },
  stop: async () => {
    try {
      set({ info: await backend.stop() });
    } catch (e) {
      set({ error: String(e) });
    }
  },
  runSetup: async () => {
    if (!unlisten) {
      unlisten = await backend.onSetup((ev) => {
        set({ setup: ev });
        if (ev.status === "done") {
          void get().refresh().then(() => get().start());
        } else if (ev.status === "failed") {
          set({ phase: "failed", error: ev.error ?? "setup failed" });
        }
      });
    }
    set({ phase: "setting-up", error: null, setup: { step: 0, steps: 4, message: "Starting…", status: "running", error: null } });
    try {
      await backend.setup();
    } catch (e) {
      set({ phase: "failed", error: String(e) });
    }
  },
}));
