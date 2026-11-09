import type { WordTime } from "@/lib/api/types";

function stamp(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}

/** Group word times into SRT cues of roughly `perLine` words, breaking early at sentence punctuation. */
export function wordsToSrt(words: WordTime[], perLine = 8): string {
  if (!words.length) return "";
  const cues: { start: number; end: number; text: string }[] = [];
  let cur: WordTime[] = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(" ").replace(/\s+([,.!?;:])/g, "$1") });
    cur = [];
  };
  for (const w of words) {
    cur.push(w);
    if (cur.length >= perLine || /[.!?]$/.test(w.text.trim())) flush();
  }
  flush();
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join("\n");
}
