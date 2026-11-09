import type { Style } from "@/lib/api/types";

export const EMO_LABELS = ["happy", "angry", "sad", "afraid", "disgusted", "melancholic", "surprised", "calm"] as const;

/** Editable copy of a style; everything the PUT body accepts. */
export type StyleDraft = Omit<Style, "builtin" | "name"> & { name: string };

export function toDraft(s: Style): StyleDraft {
  const emo = Array.from({ length: 8 }, (_, i) => s.emo_vector?.[i] ?? 0);
  return {
    name: s.name,
    title: s.title ?? "",
    description: s.description ?? "",
    pace: s.pace ?? 1,
    pause: s.pause ?? 1,
    temperature: s.temperature ?? 0.8,
    top_p: s.top_p ?? 0.95,
    repetition_penalty: s.repetition_penalty ?? 1.2,
    cfg: s.cfg ?? 2,
    exaggeration: s.exaggeration ?? 0.5,
    cfg_weight: s.cfg_weight ?? 0.5,
    instruct: s.instruct ?? "",
    desc: s.desc ?? "",
    emo_vector: emo,
    emo_alpha: s.emo_alpha ?? 0.7,
    tags: [...(s.tags ?? [])],
    sample: s.sample ?? "",
    extra: { ...(s.extra ?? {}) },
  };
}

/** Body for PUT /styles/{name}: drops the name, drops an all-zero emotion vector. */
export function toBody(d: StyleDraft): Partial<Style> {
  const { name: _name, ...rest } = d;
  const body: Partial<Style> = { ...rest };
  if (!d.emo_vector.some((v) => v > 0)) body.emo_vector = [];
  return body;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function isDirty(a: StyleDraft, b: StyleDraft): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export const SLIDERS: { key: keyof Pick<StyleDraft, "pace" | "pause" | "temperature" | "top_p" | "repetition_penalty" | "cfg" | "exaggeration" | "cfg_weight" | "emo_alpha">; label: string; min: number; max: number; step: number; hint: string; group: "delivery" | "sampling" | "engine" }[] = [
  { key: "pace", label: "Pace", min: 0.5, max: 2, step: 0.05, hint: "Tempo multiplier", group: "delivery" },
  { key: "pause", label: "Pause scale", min: 0, max: 3, step: 0.05, hint: "Length of pauses between sentences and paragraphs", group: "delivery" },
  { key: "temperature", label: "Temperature", min: 0.05, max: 1.5, step: 0.05, hint: "Randomness of the delivery; lower is steadier", group: "sampling" },
  { key: "top_p", label: "Top-p", min: 0.1, max: 1, step: 0.01, hint: "Nucleus sampling cut-off", group: "sampling" },
  { key: "repetition_penalty", label: "Repetition penalty", min: 1, max: 2, step: 0.05, hint: "Discourages repeated tokens", group: "sampling" },
  { key: "cfg", label: "Guidance (CFG)", min: 0.5, max: 6, step: 0.1, hint: "Flow / CFM engines such as VoxCPM2, dots and F5", group: "engine" },
  { key: "exaggeration", label: "Exaggeration", min: 0.25, max: 2, step: 0.05, hint: "Chatterbox emotional intensity", group: "engine" },
  { key: "cfg_weight", label: "CFG weight", min: 0, max: 1, step: 0.05, hint: "Chatterbox pacing weight", group: "engine" },
  { key: "emo_alpha", label: "Emotion strength", min: 0, max: 1, step: 0.05, hint: "IndexTTS-2 emotion vector weight", group: "engine" },
];
