import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDownToLine, ExternalLink, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { updates, RELEASES_PAGE, type UpdateCheck, type UpdateProgress } from "@/lib/updates";
import { openExternal } from "@/lib/external";
import { inTauri } from "@/lib/backend";
import { Button, ProgressBar } from "@/components/ui";
import { fmtBytes } from "@/lib/utils";

/** How long the start screen waits for the update check before opening the app anyway (a late answer still counts). */
const LAUNCH_WAIT_MS = 4000;
/** How often a running app looks for a new version. */
const RECHECK_MS = 4 * 60 * 60 * 1000;

type Phase = "idle" | "downloading" | "installing" | "failed";

/** Updates are required: when a newer FireVoice exists and can be fetched, the app shows only the update screen until
 * it is installed. Offline (or when the release server can't be reached) the app opens as usual. A version found while
 * the app is already open shows a bar first, so work in progress can finish; the next start requires it. */
export function UpdateGate({ children }: { children: ReactNode }) {
  const enabled = inTauri();
  const [launching, setLaunching] = useState(enabled);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [required, setRequired] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const install = useCallback(async () => {
    setRequired(true);
    setPhase("downloading");
    setError(null);
    setProgress(null);
    const off = await updates.onProgress((p) => {
      setProgress(p);
      if (p.total != null && p.downloaded >= p.total) setPhase("installing");
    });
    try {
      await updates.install();
      setPhase("installing"); // the installer closes the app and opens the new version
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("failed");
    } finally {
      off();
    }
  }, []);

  // at launch: required, and the download starts by itself
  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    const t = window.setTimeout(() => setLaunching(false), LAUNCH_WAIT_MS);
    void updates
      .check()
      .then((r) => {
        if (r.status === "available") {
          setUpdate(r);
          void install();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        window.clearTimeout(t);
        setLaunching(false);
      });
    return () => window.clearTimeout(t);
  }, [enabled, install]);

  // while running: look again every few hours; a find shows the bar
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      void updates.check().then((r) => r.status === "available" && setUpdate((u) => u ?? r)).catch(() => undefined);
    }, RECHECK_MS);
    return () => window.clearInterval(id);
  }, [enabled]);

  if (launching) return <Splash />;
  if (update && required) return <UpdateScreen update={update} phase={phase} progress={progress} error={error} retry={() => void install()} />;
  return (
    <>
      {update && !required && <UpdateBar version={update.version} onUpdate={() => void install()} />}
      {children}
    </>
  );
}

function Splash() {
  return (
    <div className="flex h-screen items-center justify-center bg-bg">
      <img src="/firevoice.svg" alt="" className="size-14 animate-pulse rounded-2xl" />
    </div>
  );
}

function UpdateBar({ version, onUpdate }: { version: string | null; onUpdate: () => void }) {
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-3 bg-ink px-4 py-2 text-[13px] text-surface">
      <Sparkles className="size-4 shrink-0 text-fire-2" />
      <span>
        FireVoice {version} is ready. It is a required update: finish what you are doing, then update. FireVoice restarts by itself.
      </span>
      <Button size="sm" variant="primary" leading={<ArrowDownToLine className="size-3.5" />} onClick={onUpdate}>
        Update now
      </Button>
    </div>
  );
}

function UpdateScreen({ update, phase, progress, error, retry }: { update: UpdateCheck; phase: Phase; progress: UpdateProgress | null; error: string | null; retry: () => void }) {
  const total = progress?.total ?? null;
  const frac = total ? Math.min(1, (progress?.downloaded ?? 0) / total) : 0;
  return (
    <div className="flex h-screen items-center justify-center bg-bg p-6">
      <div className="surface w-full max-w-[520px] rounded-3xl p-8 shadow-lg">
        <div className="flex items-center gap-4">
          <img src="/firevoice.svg" alt="" className="size-14 rounded-2xl" />
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Updating FireVoice</h1>
            <p className="text-[13px] text-muted">
              Version {update.version} replaces {update.current}. This update is required.
            </p>
          </div>
        </div>

        <div className="mt-7 space-y-2.5">
          {phase === "failed" ? (
            <div className="flex items-start gap-2.5 rounded-xl bg-warn-soft px-4 py-3 text-[13px] text-warn">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{error || "The update could not be installed."}</span>
            </div>
          ) : (
            <>
              <div className="flex items-baseline justify-between text-[13px]">
                <span className="flex items-center gap-2 font-medium text-ink">
                  <Loader2 className="size-4 animate-spin text-fire" />
                  {phase === "installing" ? "Installing… FireVoice will reopen by itself" : "Downloading the update…"}
                </span>
                {progress && phase === "downloading" && (
                  <span className="text-[12px] text-muted tabular">
                    {fmtBytes(progress.downloaded)}
                    {total ? ` of ${fmtBytes(total)}` : ""}
                  </span>
                )}
              </div>
              <ProgressBar value={phase === "installing" ? 1 : frac} />
            </>
          )}
        </div>

        {update.notes && (
          <div className="mt-6">
            <h2 className="mb-2 text-[11.5px] font-semibold tracking-[0.06em] text-faint uppercase">What's new</h2>
            <div className="max-h-[220px] overflow-y-auto rounded-xl bg-surface-2 px-4 py-3 text-[13px] leading-relaxed whitespace-pre-line text-ink-2">
              {update.notes}
            </div>
          </div>
        )}

        {phase === "failed" && (
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button variant="primary" leading={<RefreshCw className="size-4" />} onClick={retry}>
              Try again
            </Button>
            <Button variant="ghost" leading={<ExternalLink className="size-4" />} onClick={() => void openExternal(RELEASES_PAGE)}>
              Download it yourself
            </Button>
          </div>
        )}
        <p className="mt-6 text-[12px] text-faint">Your voices, history and settings stay as they are.</p>
      </div>
    </div>
  );
}
