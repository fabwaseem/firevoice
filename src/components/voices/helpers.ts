import type { Voice } from "@/lib/api/types";

export function initials(name: string): string {
  const parts = name.replace(/[-_:]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Gender choices for forms that describe one voice. */
export const GENDERS = [
  { value: "", label: "Not set" },
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "neutral", label: "Neutral" },
];

/** Gender choices for filtering the library. */
export const GENDER_FILTERS = [{ value: "", label: "Any gender" }, ...GENDERS.slice(1)];

/** "cloned" -> "Cloned", "designed" -> "Designed". */
export function kindLabel(kind: string | undefined): string {
  if (kind === "designed") return "Designed";
  if (kind === "cloned") return "Cloned";
  return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "";
}

export function genderLabel(g: string | undefined): string {
  if (!g) return "";
  return g.charAt(0).toUpperCase() + g.slice(1);
}

export function parseTags(s: string): string[] {
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function voiceSubtitle(v: Voice): string {
  const bits = [genderLabel(v.gender), v.accent].filter(Boolean);
  return bits.join(" · ");
}

export const DESIGN_EXAMPLES = [
  "A warm, mid-forties documentary narrator with a slight gravel and unhurried pacing",
  "A bright, upbeat young woman who sounds like a friendly podcast host",
  "A hushed, menacing horror storyteller with a low, deliberate voice",
];
