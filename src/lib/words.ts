import type { WordTime } from "@/lib/api/types";

/** A timed word as transcripts and renders carry it (Urdu also has a Roman reading). */
export type TimedWord = WordTime & { speaker?: string; roman?: string };

export type WordFormat = "csv" | "json" | "srt" | "vtt";

export const WORD_FORMATS: { value: WordFormat; label: string; hint: string }[] = [
  { value: "csv", label: "Words with times (.csv)", hint: "Opens in Excel or Sheets: word, start, end, speaker" },
  { value: "json", label: "Words with times (.json)", hint: "For apps and scripts" },
  { value: "srt", label: "Word-by-word subtitles (.srt)", hint: "One word on screen at a time" },
  { value: "vtt", label: "Word-by-word subtitles (.vtt)", hint: "The same, for web players" },
];

/** The word as shown: Roman letters for Urdu, no stray spaces. */
export function wordText(w: TimedWord): string {
  return (w.roman ?? w.text ?? "").trim();
}

/** Does this word attach to the one before it (punctuation, or a piece like "-salamu" / "'s")? */
export function attachesToPrevious(next: string): boolean {
  return /^[,.!?;:)\]}%]/.test(next) || /^[-'’]\p{L}/u.test(next);
}

/** Join words into readable text: one space between words, none before punctuation or attached pieces. */
export function joinWords(words: TimedWord[]): string {
  return words
    .map(wordText)
    .filter(Boolean)
    .reduce((out, t, i) => (i === 0 ? t : out + (attachesToPrevious(t) ? "" : " ") + t), "")
    .replace(/([([{])\s+/g, "$1");
}

function stamp(sec: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(r).padStart(3, "0")}`;
}

function csvCell(v: string | number | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Word-level timings in a file format; each word keeps its own start and end. */
export function wordsFile(words: TimedWord[], format: WordFormat): { text: string; mime: string; ext: string } {
  const list = words.filter((w) => wordText(w));
  const anySpeaker = list.some((w) => w.speaker);
  if (format === "csv") {
    const head = anySpeaker ? "index,word,start,end,speaker" : "index,word,start,end";
    const rows = list.map((w, i) => [i + 1, csvCell(wordText(w)), w.start.toFixed(3), w.end.toFixed(3), ...(anySpeaker ? [csvCell(w.speaker)] : [])].join(","));
    return { text: "﻿" + [head, ...rows].join("\r\n") + "\r\n", mime: "text/csv", ext: "csv" };
  }
  if (format === "json") {
    const data = list.map((w, i) => ({ index: i + 1, word: wordText(w), start: +w.start.toFixed(3), end: +w.end.toFixed(3), ...(w.speaker ? { speaker: w.speaker } : {}) }));
    return { text: JSON.stringify({ words: data }, null, 1), mime: "application/json", ext: "json" };
  }
  const sep = format === "srt" ? "," : ".";
  const cues = list.map((w, i) => {
    // a word stays up until the next one starts (no flicker between words), at least 0.12 s
    const next = list[i + 1];
    const end = Math.max(w.start + 0.12, next && next.start - w.end < 0.6 ? next.start : w.end);
    const who = anySpeaker && w.speaker && w.speaker !== list[i - 1]?.speaker ? `${w.speaker}: ` : "";
    return `${format === "srt" ? `${i + 1}\n` : ""}${stamp(w.start, sep)} --> ${stamp(end, sep)}\n${who}${wordText(w)}\n`;
  });
  return { text: (format === "vtt" ? "WEBVTT\n\n" : "") + cues.join("\n"), mime: format === "srt" ? "application/x-subrip" : "text/vtt", ext: format };
}
