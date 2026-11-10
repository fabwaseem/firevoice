import type { Job } from "@/lib/api/types";
import { api, downloadFile, safeFileName } from "@/lib/api/client";

export type Tone = "neutral" | "fire" | "ok" | "warn" | "bad" | "info";

export function statusTone(status: Job["status"]): Tone {
  switch (status) {
    case "running": return "fire";
    case "done": return "ok";
    case "failed": return "bad";
    case "cancelled": return "warn";
    default: return "neutral";
  }
}

export const STATUS_LABEL: Record<Job["status"], string> = {
  queued: "Queued", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled",
};
/** "running" -> "Running"; unknown values are capitalised. */
export function statusLabel(status: string): string {
  return (STATUS_LABEL as Record<string, string>)[status] ?? (status ? status.charAt(0).toUpperCase() + status.slice(1) : "");
}

export function jobTitle(job: Job): string {
  return job.title?.trim() || kindLabel(job.kind);
}

export function errorText(job: Job): string | null {
  if (!job.error) return null;
  if (typeof job.error === "string") return job.error;
  return job.error.message || "Something went wrong.";
}

export function isTerminal(job: Job): boolean {
  return job.status === "done" || job.status === "failed" || job.status === "cancelled";
}

/** The audio file a finished dub wrote, if any. */
function dubAudio(job: Job): string | undefined {
  const a = job.result?.audio;
  return job.kind === "dub" && typeof a === "string" && a ? a : undefined;
}

export function hasAudio(job: Job): boolean {
  return job.status === "done" && (job.kind === "tts" || job.kind === "design" || !!dubAudio(job));
}

/** Where to stream a finished job's audio from. */
export function jobAudioSrc(job: Job): string {
  const dub = dubAudio(job);
  return dub ? api.jobFileUrl(job.id, dub) : api.jobAudioUrl(job.id);
}

/** Download a finished job's audio through the save dialog (fetched with the auth header). */
export async function downloadJobAudio(job: Job): Promise<void> {
  const dub = dubAudio(job);
  const ext = dub ? (dub.split(".").pop() ?? "mp3") : String(job.result?.format ?? "mp3");
  const name = `${safeFileName(jobTitle(job), job.id)}.${ext}`;
  await downloadFile(dub ? api.jobFileUrl(job.id, dub) : api.jobAudioUrl(job.id, true), name);
}

/** Pull a readable summary of the original request out of a job payload. */
export function payloadSummary(job: Job): { engine?: string; voice?: string; style?: string; text?: string; lines?: number; description?: string } {
  const p = (job.payload ?? {}) as Record<string, unknown>;
  if (job.kind === "tts") {
    const r = (p.request ?? {}) as Record<string, unknown>;
    return { engine: str(r.engine), voice: str(r.voice), style: str(r.style), text: str(r.text) };
  }
  if (job.kind === "batch") {
    const d = (p.defaults ?? {}) as Record<string, unknown>;
    const lines = Array.isArray(p.lines) ? p.lines.length : undefined;
    return { engine: str(d.engine), voice: str(d.voice), style: str(d.style), lines };
  }
  return { engine: str(p.engine), description: str(p.description), text: str(p.text) };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function resultNumber(job: Job, key: string): number | undefined {
  const v = job.result?.[key];
  return typeof v === "number" ? v : undefined;
}

export function resultCount(job: Job, key: string): number | undefined {
  const v = job.result?.[key];
  return Array.isArray(v) ? v.length : typeof v === "number" ? v : undefined;
}

export const KIND_LABEL: Record<Job["kind"], string> = {
  tts: "Speech", batch: "Batch", design: "Voice design", previews: "Previews", project: "Project", style_refs: "Style clips",
  dialogue: "Dialogue", install: "Engine install", dub: "Dubbing",
};
export function kindLabel(kind: Job["kind"]): string {
  return KIND_LABEL[kind] ?? (kind ? (kind.charAt(0).toUpperCase() + kind.slice(1)).replace(/_/g, " ") : "Job");
}
