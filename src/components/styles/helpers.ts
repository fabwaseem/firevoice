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
  { key: "pace", label: "Pace", min: 0.5, max: 2, step: 0.05, hint: "How fast the voice speaks", group: "delivery" },
  { key: "pause", label: "Pause length", min: 0, max: 3, step: 0.05, hint: "Length of pauses between sentences and paragraphs", group: "delivery" },
  { key: "temperature", label: "Variety", min: 0.05, max: 1.5, step: 0.05, hint: "How much each take varies; lower is steadier", group: "sampling" },
  { key: "top_p", label: "Range of choices", min: 0.1, max: 1, step: 0.01, hint: "Lower keeps the delivery safer and more predictable", group: "sampling" },
  { key: "repetition_penalty", label: "Avoid repeats", min: 1, max: 2, step: 0.05, hint: "Higher stops the voice repeating sounds or words", group: "sampling" },
  { key: "cfg", label: "Follow the style", min: 0.5, max: 6, step: 0.1, hint: "Inferno, Hearth and Flicker: how closely they stick to the style", group: "engine" },
  { key: "exaggeration", label: "Exaggeration", min: 0.25, max: 2, step: 0.05, hint: "Torch and Flash: emotional intensity", group: "engine" },
  { key: "cfg_weight", label: "Pacing control", min: 0, max: 1, step: 0.05, hint: "Torch and Flash: how strongly pacing follows the style", group: "engine" },
  { key: "emo_alpha", label: "Emotion strength", min: 0, max: 1, step: 0.05, hint: "Firebrand and Firestorm: how strongly the emotions below apply", group: "engine" },
];
