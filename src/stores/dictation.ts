import { create } from "zustand";
import { persist } from "zustand/middleware";

/** How dictation behaves. Saved on this computer and sent to the desktop shell, which does the work. */
export interface DictationConfig {
  enabled: boolean;
  /** e.g. "Ctrl+Alt+Space" (key names as the keyboard reports them: KeyD, Space, F9) */
  hotkey: string;
  /** toggle: press to start, press again to stop. hold: speak while the keys are down. */
  activation: "toggle" | "hold";
  /** realtime: typed as you speak. onstop: inserted when you stop. */
  mode: "realtime" | "onstop";
  /** "auto" or a language code */
  language: string;
  /** type: keystrokes. paste: through the clipboard (put back afterwards). */
  insert: "type" | "paste";
  /** spoken "new line" and "new paragraph" become line breaks */
  commands: boolean;
  /** drop um and uh */
  fillers: boolean;
  /** a sound when listening starts and stops */
  sounds: boolean;
  /** the microphone's name; "" = the system's default */
  mic: string;
  /** closing the window keeps FireVoice in the tray, so the hotkey keeps working */
  keepInTray: boolean;
  /** names and terms to spell right */
  keyterms: string[];
}

export interface DictationEntry {
  id: string;
  text: string;
  /** seconds of speech */
  seconds: number;
  /** epoch ms */
  at: number;
  language: string | null;
  mode: string;
}

export const DEFAULT_DICTATION: DictationConfig = {
  enabled: false,
  hotkey: "Ctrl+Alt+Space",
  activation: "toggle",
  mode: "realtime",
  language: "auto",
  insert: "type",
  commands: true,
  fillers: true,
  sounds: true,
  mic: "",
  keepInTray: true,
  keyterms: [],
};

const KEEP = 100;

interface DictationStore {
  config: DictationConfig;
  history: DictationEntry[];
  /** totals over everything dictated, also what has left the history */
  words: number;
  seconds: number;
  set: (patch: Partial<DictationConfig>) => void;
  add: (e: Omit<DictationEntry, "id" | "at">) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

export const useDictation = create<DictationStore>()(
  persist(
    (set) => ({
      config: DEFAULT_DICTATION,
      history: [],
      words: 0,
      seconds: 0,
      set: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),
      add: (e) =>
        set((s) => ({
          history: [{ ...e, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now() }, ...s.history].slice(0, KEEP),
          words: s.words + countWords(e.text),
          seconds: s.seconds + e.seconds,
        })),
      remove: (id) => set((s) => ({ history: s.history.filter((h) => h.id !== id) })),
      clear: () => set({ history: [] }),
    }),
    {
      name: "firevoice.dictation",
      version: 1,
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DictationStore>;
        return { ...current, ...p, config: { ...DEFAULT_DICTATION, ...(p.config ?? {}) } };
      },
    },
  ),
);

/** What dictation is doing right now (not saved). */
export type DictationPhase = "idle" | "starting" | "listening" | "finishing" | "error";

interface LiveStore {
  phase: DictationPhase;
  message: string | null;
  text: string;
  tentative: string;
  /** why the hotkey could not be registered, if it could not */
  hotkeyError: string | null;
  set: (patch: Partial<Omit<LiveStore, "set">>) => void;
}

export const useDictationLive = create<LiveStore>()((set) => ({
  phase: "idle",
  message: null,
  text: "",
  tentative: "",
  hotkeyError: null,
  set: (patch) => set(patch),
}));
