import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Cpu, FileText, Loader2, PackageOpen, RotateCw, Sparkles } from "@/components/icons";
import { useJobs } from "@/lib/api/hooks";
import type { Job } from "@/lib/api/types";
import { backend, fmtBytes, fmtEta, type ExtrasItem } from "@/lib/backend";
import { useBackend } from "@/stores/backend";
import { Button, Dialog, ProgressBar } from "@/components/ui";
import { cn } from "@/lib/utils";
import { InCorner } from "./Corner";

/** The part of the setup that runs after the user is in: torch and the voice libraries (from the desktop shell), and
 * any engine still installing. A small card in the corner that can fold down to a pill; it never blocks the app. */
export function BackgroundSetup({ startFolded = false }: { startFolded?: boolean }) {
  const extras = useBackend((s) => s.extras);
  const jobs = useInstallJobs();
  const [folded, setFolded] = useState(() => {
    try {
      const saved = sessionStorage.getItem("fv-setup-folded");
      return saved == null ? startFolded : saved === "1";
    } catch {
      return startFolded;
    }
  });
  const [log, setLog] = useState<string | null>(null);
  const fold = (v: boolean) => {
    setFolded(v);
    try {
      sessionStorage.setItem("fv-setup-folded", v ? "1" : "0");
    } catch {
      /* private mode: the card just unfolds next time */
    }
  };

  // "All set" shows for a few seconds after a setup this window watched, then the card goes away
  const watched = useRef(false);
  const [celebrate, setCelebrate] = useState(false);
  const running = extras?.status === "running";
  if (running) watched.current = true;
  useEffect(() => {
    if (extras?.status !== "done" || !watched.current) return;
    watched.current = false;
    setCelebrate(true);
    const t = setTimeout(() => setCelebrate(false), 6000);
    return () => clearTimeout(t);
  }, [extras?.status]);

  const failed = extras?.status === "failed";
  const show = running || failed || celebrate || jobs.length > 0;
  if (!show) return null;

  const progress = running ? extras.progress : failed ? extras.progress : 1;
  const downloading = running && extras.stage === "download" && extras.total_bytes > 0;
  const title = failed
    ? "Setup stopped"
    : running
      ? "Finishing setup"
      : jobs.length
        ? `Installing ${jobs[0].title.replace(/^Install(ing)?\s+/i, "")}`
        : "FireVoice is ready";

  if (folded) {
    return (
      <InCorner order={1}>
        <button
          type="button"
          onClick={() => fold(false)}
          className="surface-raised flex items-center gap-2.5 rounded-full py-2 pr-4 pl-2.5 text-[12.5px] font-medium text-ink shadow-lg transition-transform hover:-translate-y-0.5"
          aria-label="Show setup progress"
        >
          <Ring value={running ? progress : (jobs[0]?.progress ?? 1)} failed={failed} />
          {failed
            ? "Setup stopped"
            : running
              ? `Setting up · ${Math.round(progress * 100)}%`
              : jobs.length
                ? `Engine · ${Math.round((jobs[0].progress ?? 0) * 100)}%`
                : "Ready"}
        </button>
      </InCorner>
    );
  }

  return (
    <InCorner order={1}>
      <section aria-label="Setup progress" className="surface-raised onb-in w-[360px] overflow-hidden rounded-2xl shadow-[0_24px_60px_-20px_rgba(0,0,0,0.45)]">
        <header className="flex items-center gap-3 px-4 pt-3.5 pb-3">
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-xl",
              failed ? "bg-bad/10 text-bad" : running || jobs.length ? "fire-gradient text-white" : "bg-ok text-white",
            )}
          >
            {failed ? <AlertTriangle className="size-4" /> : running || jobs.length ? <Cpu className="size-4" /> : <Check className="size-4" strokeWidth={3} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-ink">{title}</div>
            <div className="truncate text-[12px] text-muted">
              {failed
                ? "Nothing is lost. Try again and it picks up where it stopped."
                : running || jobs.length
                  ? "You can use FireVoice meanwhile."
                  : "Everything is installed. Making voices is ready."}
            </div>
          </div>
          <button type="button" onClick={() => fold(true)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Fold up">
            <ChevronDown className="size-4" />
          </button>
        </header>

        {(running || failed) && extras && (
          <div className="border-t border-line px-4 py-3.5">
            <div className="mb-1.5 flex items-baseline justify-between text-[12.5px]">
              <span className="font-medium text-ink tabular">{Math.round(progress * 100)}%</span>
              {downloading && (
                <span className="text-faint tabular">
                  {fmtBytes(extras.bytes_per_sec)}/s
                  {fmtEta(extras.total_bytes - extras.done_bytes, extras.bytes_per_sec) &&
                    ` · ${fmtEta(extras.total_bytes - extras.done_bytes, extras.bytes_per_sec)}`}
                </span>
              )}
            </div>
            <ProgressBar value={progress} />
            <ul className="mt-3 space-y-2">
              {extras.items.map((i) => (
                <ItemRow key={i.id} item={failed && i.state === "active" ? { ...i, state: "waiting" } : i} />
              ))}
            </ul>
            {running && extras.message && (
              <p className="mt-2.5 truncate text-[11.5px] text-faint" title={extras.message}>
                {extras.message}
              </p>
            )}
            {failed && (
              <>
                <p className="mt-3 line-clamp-3 text-[12.5px] break-words text-bad">{extras.error}</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="primary" leading={<RotateCw className="size-3.5" />} onClick={() => void useBackend.getState().finishSetup()}>
                    Try again
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    leading={<FileText className="size-3.5" />}
                    onClick={async () => setLog(await backend.logs(300).catch((e) => String(e)))}
                  >
                    Show the log
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {jobs.map((j) => (
          <div key={j.id} className="border-t border-line px-4 py-3.5">
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="flex min-w-0 items-center gap-2 font-medium text-ink">
                <PackageOpen className="size-3.5 shrink-0 text-fire" />
                <span className="truncate">{j.title}</span>
              </span>
              <span className="text-faint tabular">{Math.round((j.progress ?? 0) * 100)}%</span>
            </div>
            <ProgressBar value={j.progress ?? 0} />
            <p className="mt-2 truncate text-[11.5px] text-faint" title={j.message ?? undefined}>
              {j.message || "Waiting to start…"}
            </p>
          </div>
        ))}

        {celebrate && !running && !jobs.length && (
          <div className="flex items-center gap-2 border-t border-line px-4 py-3 text-[12.5px] text-ink-2">
            <Sparkles className="size-3.5 text-fire" /> All set. Enjoy FireVoice.
          </div>
        )}

        <Dialog
          open={log != null}
          onOpenChange={(v) => !v && setLog(null)}
          title="Setup log"
          description="Technical details that help explain what went wrong."
          size="xl"
        >
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2 select-text">
            {log || "(empty)"}
          </pre>
        </Dialog>
      </section>
    </InCorner>
  );
}

function ItemRow({ item }: { item: ExtrasItem }) {
  const bytes = item.total > 0 && item.id !== "check";
  return (
    <li className="flex items-center gap-2.5 text-[12.5px]">
      <span
        className={cn(
          "flex size-4.5 shrink-0 items-center justify-center rounded-full",
          item.state === "done" ? "bg-ok text-white" : item.state === "active" ? "text-fire" : "border border-line text-faint",
        )}
      >
        {item.state === "done" ? <Check className="size-3" strokeWidth={3} /> : item.state === "active" ? <Loader2 className="size-3.5 animate-spin" /> : null}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", item.state === "waiting" ? "text-muted" : "text-ink")}>{item.label}</span>
      <span className="shrink-0 text-faint tabular">
        {item.state === "done"
          ? "Done"
          : item.state === "waiting"
            ? bytes
              ? fmtBytes(item.total)
              : "Waiting"
            : bytes
              ? `${fmtBytes(item.done)} of ${fmtBytes(item.total)}`
              : "Working…"}
      </span>
    </li>
  );
}

/** A tiny progress ring for the folded pill. */
function Ring({ value, failed }: { value: number; failed?: boolean }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 20 20" className="size-5 -rotate-90" aria-hidden>
      <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" className="stroke-surface-3" />
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className={failed ? "stroke-bad" : "stroke-fire"}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))}
        style={{ transition: "stroke-dashoffset 0.3s" }}
      />
    </svg>
  );
}

/** Engine installs and the writing assistant's install, still queued or running (refreshed every few seconds while
 * there are any). */
function useInstallJobs(): Job[] {
  const engines = useJobs({ kind: "install", limit: 10 });
  const writer = useJobs({ kind: "writer", limit: 3 });
  const live = (j: Job) => j.status === "queued" || j.status === "running";
  const active = [...(engines.data?.jobs ?? []), ...(writer.data?.jobs ?? [])].filter(live);
  const r1 = engines.refetch;
  const r2 = writer.refetch;
  useEffect(() => {
    if (!active.length) return;
    const t = setInterval(() => {
      void r1();
      void r2();
    }, 2000);
    return () => clearInterval(t);
  }, [active.length, r1, r2]);
  return active;
}
