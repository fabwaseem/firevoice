import { create } from "zustand";
import { backend, inTauri, localPort, type BackendInfo, type SetupEvent } from "@/lib/backend";
import { useSettings } from "./settings";

type Phase = "idle" | "starting" | "needs-setup" | "needs-update" | "setting-up" | "failed";

interface BackendState {
  info: BackendInfo | null;
  phase: Phase;
  setup: SetupEvent | null;
  error: string | null;
  /** start() has handed the process over (so a "not running" answer now means it exited) */
  launched: boolean;
  /** the user asked to stop it, so its exit is not a crash */
  stopRequested: boolean;
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
  launched: false,
  stopRequested: false,
  set: (p) => set(p),
  refresh: async () => {
    if (!inTauri()) return null;
    try {
      const info = await backend.info();
      const prev = get();
      set({ info });
      // A managed backend that exits on its own is reported right away instead of after the start timeout.
      if (!info.running && !info.setup_running && !prev.stopRequested) {
        if (prev.phase === "starting" && prev.launched) {
          set({ phase: "failed", launched: false, error: "FireVoice's voice engine stopped while starting. The log usually says why." });
        } else if (prev.phase === "idle" && prev.info?.running) {
          set({ phase: "failed", launched: false, error: "FireVoice's voice engine stopped unexpectedly. The log usually says why." });
        }
      }
      return info;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },
  start: async () => {
    const port = localPort(useSettings.getState().serverUrl) ?? 8787;
    set({ phase: "starting", error: null, launched: false, stopRequested: false });
    try {
      // stays "starting" until /health answers (BackendManager watches that)
      const info = await backend.start(port);
      set({ info, launched: true });
    } catch (e) {
      set({ phase: "failed", error: String(e) });
    }
  },
  stop: async () => {
    set({ stopRequested: true, launched: false });
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
          set({ phase: "failed", error: ev.error ?? "Setup did not finish. Please try again." });
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
