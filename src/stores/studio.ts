import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Engines that cannot read text aloud: never a Speak or Dialogue engine. */
const NOT_SPEECH = new Set(["chatterbox-vc", "separator", "musicgen", "audioldm2"]);

/** The Speak view's draft. Persisted so a restart never loses a script. */
export interface StudioState {
  text: string;
  engine: string | null;
  voice: string;
  style: string;
  pace: number;
  seed: number;
  language: string | null;
  instruct: string | null;
  params: Record<string, unknown>;
  styleOverrides: Record<string, unknown>;
  candidates: number;
  accept: number;
  validate: boolean;
  keepTakes: boolean;
  lufs: number | null;
  leadMs: number;
  tailMs: number;
  sampleRate: number | null;
  set: (patch: Partial<Omit<StudioState, "set" | "setParam" | "resetParams">>) => void;
  setParam: (name: string, value: unknown) => void;
  resetParams: () => void;
}

export const SAMPLE_TEXT =
  "Hello, and welcome to FireVoice. [pause 400ms] Every sentence you write here is rendered in parallel on your own GPU, checked by speech recognition, and mastered before you hear it.\n\nTry a style, pick a voice, and press play.";

export const useStudio = create<StudioState>()(
  persist(
    (set) => ({
      text: SAMPLE_TEXT,
      engine: null,
      voice: "default",
      style: "conversational",
      pace: 1,
      seed: 1234,
      language: null,
      instruct: null,
      params: {},
      styleOverrides: {},
      candidates: 1,
      accept: 0.9,
      validate: true,
      keepTakes: true,
      lufs: -16,
      leadMs: 120,
      tailMs: 280,
      sampleRate: null,
      set: (patch) => set(patch),
      setParam: (name, value) => set((s) => ({ params: { ...s.params, [name]: value } })),
      resetParams: () => set({ params: {} }),
    }),
    {
      name: "firevoice.studio",
      version: 1,
      // older versions could save a non-speech engine here (the voice changer's "Use in Speak"); it reads no text,
      // so Speak and Dialogue came back silent. Forget it and use the default speech engine.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<StudioState>;
        return { ...current, ...p, engine: p.engine && NOT_SPEECH.has(p.engine) ? null : (p.engine ?? current.engine) };
      },
    },
  ),
);
