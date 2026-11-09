import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "0:00";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "–";
  if (sec < 60) return `${sec.toFixed(1)} s`;
  return fmtTime(sec);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtGB(gb: number | null | undefined): string {
  if (gb == null) return "–";
  return `${gb.toFixed(1)} GB`;
}

export function relTime(epochSec: number | null | undefined): string {
  if (!epochSec) return "";
  const diff = Date.now() / 1000 - epochSec;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)} d ago`;
  return new Date(epochSec * 1000).toLocaleDateString();
}

export function titleCase(s: string): string {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", ur: "Urdu", hi: "Hindi", ar: "Arabic", zh: "Chinese", ja: "Japanese", ko: "Korean", de: "German",
  fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese", ru: "Russian", tr: "Turkish", nl: "Dutch", pl: "Polish",
  sv: "Swedish", da: "Danish", fi: "Finnish", no: "Norwegian", el: "Greek", he: "Hebrew", id: "Indonesian", ms: "Malay",
  th: "Thai", vi: "Vietnamese", tl: "Filipino", sw: "Swahili", my: "Burmese", km: "Khmer", lo: "Lao", "*": "Many",
};

export function langName(code: string | null | undefined): string {
  if (!code) return "Auto";
  return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}
