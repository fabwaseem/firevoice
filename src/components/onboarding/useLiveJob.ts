import { useEffect } from "react";
import { useJob } from "@/lib/api/hooks";
import type { Job } from "@/lib/api/types";

export const jobActive = (j?: Job | null) => !!j && (j.status === "queued" || j.status === "running");

/** The plain text of a failed job's error. */
export function jobError(j?: Job | null): string | null {
  if (!j || j.status !== "failed") return null;
  const e = j.error;
  return (typeof e === "string" ? e : e?.message) || "That did not finish.";
}

/** A server job, kept fresh while it runs (the app's job feed is not running yet during the first run). */
export function useLiveJob(id: string | null): Job | undefined {
  const q = useJob(id);
  const job = q.data;
  const active = !!job && jobActive(job);
  const { refetch } = q;
  useEffect(() => {
    if (!id || (job && !active)) return;
    const t = setInterval(() => void refetch(), 1500);
    return () => clearInterval(t);
  }, [id, job, active, refetch]);
  return job;
}
