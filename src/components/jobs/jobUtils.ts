import type { Job } from "@/lib/api/types";

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

export function jobTitle(job: Job): string {
  return job.title?.trim() || `${job.kind} · ${job.id.slice(0, 8)}`;
}

export function errorText(job: Job): string | null {
  if (!job.error) return null;
  if (typeof job.error === "string") return job.error;
  const code = job.error.code ? `${job.error.code}: ` : "";
  return `${code}${job.error.message ?? "unknown error"}`;
}

export function isTerminal(job: Job): boolean {
  return job.status === "done" || job.status === "failed" || job.status === "cancelled";
}

export function hasAudio(job: Job): boolean {
  return job.status === "done" && (job.kind === "tts" || job.kind === "design");
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

export const KIND_LABEL: Record<Job["kind"], string> = { tts: "Speech", batch: "Batch", design: "Voice design" };
export function kindLabel(kind: Job["kind"]): string {
  return KIND_LABEL[kind] ?? kind;
}
