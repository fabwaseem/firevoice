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
  /** whisper mode: quiet speech is brought up to a normal level */
  boostQuiet: boolean;
  /** keep each dictation in the history */
  history: boolean;
  /** "when you stop" mode: the writing assistant cleans the text up before it goes in */
  polish: boolean;
  /** the writing style for each kind of app (messages, work chat, email, code, documents, other) */
  styles: Record<AppKind, WritingStyle>;
  /** command mode: select text, press this and say what to do with it ("" = off) */
  commandHotkey: string;
  /** the writing assistant was removed on purpose: never download it again by itself */
  assistantDeclined: boolean;
  /** automatic language: the languages you speak (empty: any) */
  languages: string[];
  /** translated dictation: write what is said in this language ("" = off) */
  translateTo: string;
  /** the newest batch of dictation features the user has opened the page since (the sidebar's "New" goes) */
  featuresVisited: number;
  /** ...and has closed the "What's new" card for */
  featuresSeen: number;
}

/** Raise when dictation gains features worth pointing out: the sidebar says "New" and the page shows what came. */
export const FEATURES_VERSION = 1;

export type AppKind = "messages" | "work chat" | "email" | "code" | "documents" | "other";
export type WritingStyle = "formal" | "casual" | "very casual" | "code";
export const DEFAULT_STYLES: Record<AppKind, WritingStyle> = {
  messages: "casual",
  "work chat": "casual",
  email: "formal",
  code: "code",
  documents: "formal",
  other: "formal",
};

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
  mode: "onstop",
  language: "auto",
  insert: "type",
  commands: true,
  fillers: true,
  sounds: true,
  mic: "",
  keepInTray: true,
  keyterms: [],
  boostQuiet: false,
  history: true,
  polish: true,
  styles: DEFAULT_STYLES,
  commandHotkey: "Ctrl+Alt+Shift+Space",
  assistantDeclined: false,
  languages: [],
  translateTo: "",
  featuresVisited: 0,
  featuresSeen: 0,
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
      version: 2,
      // 1 -> 2: Polished ("when you stop") became the default mode; settings from before take it too
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<DictationStore>;
        if (version < 2 && p.config) p.config = { ...p.config, mode: "onstop" };
        return p as DictationStore;
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DictationStore>;
        const config = { ...DEFAULT_DICTATION, ...(p.config ?? {}) };
        return { ...current, ...p, config: { ...config, styles: { ...DEFAULT_STYLES, ...(config.styles ?? {}) } } };
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
