import { useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import { AlertTriangle, ArrowDownToLine, Check, ChevronDown, ChevronUp, ExternalLink, Loader2, RefreshCw, RotateCw, Sparkles, X } from "@/components/icons";
import { updates, RELEASES_PAGE, type UpdateCheck, type UpdateStatus } from "@/lib/updates";
import { openExternal } from "@/lib/external";
import { fmtBytes, fmtEta, inTauri } from "@/lib/backend";
import { Button, Markdown, ProgressBar, Tooltip } from "@/components/ui";
import { cn } from "@/lib/utils";
import { CornerHost, InCorner } from "./Corner";

/** How often a running app looks for a new version (it also looks when its window comes back into view, and when the
 * connection returns). The feed is one small file on GitHub's download servers, so this costs next to nothing. */
const RECHECK_MS = 30 * 60 * 1000;
/** Looking again on focus or reconnect waits at least this long after the last look. */
const MIN_GAP_MS = 5 * 60 * 1000;

interface UpdatesState {
  check: UpdateCheck | null;
  status: UpdateStatus | null;
  installing: boolean;
  installError: string | null;
  /** the card folded down to a pill */
  folded: boolean;
  /** "Later" on this version: no card until the next start or a manual check */
  dismissed: string | null;
  /** a check the user asked for (Settings): it says so when there is nothing new */
  manual: "checking" | "none" | "offline" | null;
  /** when the last check ran (ms) */
  lastCheck: number;
  set: (p: Partial<UpdatesState>) => void;
  /** look for a new version (`manual` from Settings: shows the card again and reports "up to date") */
  runCheck: (manual?: boolean) => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
}

export const useUpdates = create<UpdatesState>()((set, get) => ({
  check: null,
  status: null,
  installing: false,
  installError: null,
  folded: false,
  dismissed: null,
  manual: null,
  lastCheck: 0,
  set: (p) => set(p),
  runCheck: async (manual = false) => {
    if (!inTauri()) return;
    void listen();
    set({ lastCheck: Date.now() });
    if (manual) set({ manual: "checking", dismissed: null, folded: false });
    try {
      const r = await updates.check();
      if (r.status === "available") set({ check: r, manual: null });
      else if (manual) set({ manual: r.status === "offline" ? "offline" : "none" });
      set({ status: await updates.status() });
    } catch {
      if (manual) set({ manual: "offline" });
    }
  },
  download: async () => {
    set({ folded: false });
    await listen();
    try {
      await updates.download();
    } catch (e) {
      set({ status: { ...(get().status ?? empty), state: "failed", error: String(e) } });
    }
  },
  install: async () => {
    set({ installing: true, installError: null });
    try {
      await updates.install(); // the app closes here and the new version opens
    } catch (e) {
      set({ installing: false, installError: e instanceof Error ? e.message : String(e) });
    }
  },
}));

let listening: Promise<unknown> | null = null;
/** Follow the shell's download events, once. */
function listen() {
  listening ??= updates.onProgress((s) => useUpdates.getState().set({ status: s }));
  return listening;
}

const empty: UpdateStatus = { state: "", version: null, downloaded: 0, total: null, bytes_per_sec: 0, error: null };

/** Updates never block the app: a new version shows a card in the corner, the user downloads it when they like
 * (with real progress), and installs it when they are ready (FireVoice restarts into it). */
export function UpdateGate({ children }: { children: ReactNode }) {
  const enabled = inTauri();

  useEffect(() => {
    if (!enabled) return;
    const check = () => void useUpdates.getState().runCheck();
    // the window shown again (from the tray, or brought to the front) or the connection back: look, unless we just did
    const soon = () => {
      if (document.visibilityState === "visible" && Date.now() - useUpdates.getState().lastCheck > MIN_GAP_MS) check();
    };
    // a moment after start (the app first), then every half hour
    const first = window.setTimeout(check, 3000);
    const again = window.setInterval(check, RECHECK_MS);
    document.addEventListener("visibilitychange", soon);
    window.addEventListener("focus", soon);
    window.addEventListener("online", soon);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(again);
      document.removeEventListener("visibilitychange", soon);
      window.removeEventListener("focus", soon);
      window.removeEventListener("online", soon);
    };
  }, [enabled]);

  return (
    <>
      {children}
      <CornerHost />
      <UpdateCard />
    </>
  );
}

function UpdateCard() {
  const { check, status, installing, installError, folded, dismissed, manual } = useUpdates();
  const set = useUpdates((s) => s.set);
  const [notesOpen, setNotesOpen] = useState(false);

  // a check from Settings that found nothing says so for a moment
  useEffect(() => {
    if (manual !== "none" && manual !== "offline") return;
    const t = setTimeout(() => set({ manual: null }), 5000);
    return () => clearTimeout(t);
  }, [manual, set]);

  if (manual === "checking" || manual === "none" || manual === "offline") {
    return (
      <InCorner order={0}>
        <div className="surface-raised onb-in flex items-center gap-2.5 rounded-full py-2 pr-4 pl-3 text-[12.5px] font-medium text-ink shadow-lg">
          {manual === "checking" ? (
            <Loader2 className="size-4 animate-spin text-fire" />
          ) : manual === "none" ? (
            <Check className="size-4 text-ok" strokeWidth={3} />
          ) : (
            <AlertTriangle className="size-4 text-warn" />
          )}
          {manual === "checking" ? "Checking for updates…" : manual === "none" ? "FireVoice is up to date" : "Could not reach the update server"}
        </div>
      </InCorner>
    );
  }

  if (!check || check.status !== "available" || !check.version) return null;
  const state = installing ? "installing" : status?.version === check.version ? status.state || "idle" : "idle";
  // "Later" or folding closes the card; the pill in the sidebar (UpdatePill) keeps the update in sight and reopens it
  if ((folded || dismissed === check.version) && state !== "installing") return null;

  const frac = status?.total ? Math.min(1, status.downloaded / status.total) : 0;
  const eta = status?.total ? fmtEta(status.total - status.downloaded, status.bytes_per_sec) : "";

  return (
    <InCorner order={0}>
      <section aria-label="App update" className="surface-raised onb-in w-[360px] overflow-hidden rounded-2xl shadow-[0_24px_60px_-20px_rgba(0,0,0,0.45)]">
        <header className="flex items-start gap-3 px-4 pt-3.5 pb-3">
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-xl",
              state === "failed" ? "bg-bad/10 text-bad" : state === "ready" ? "bg-ok text-white" : "fire-gradient text-white",
            )}
          >
            {state === "failed" ? <AlertTriangle className="size-4" /> : state === "ready" ? <Check className="size-4" strokeWidth={3} /> : <Sparkles className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-ink">
              {state === "ready" ? "Update ready to install" : state === "installing" ? "Installing the update" : `FireVoice ${check.version} is available`}
            </div>
            <div className="text-[12px] text-muted">
              {state === "ready"
                ? `FireVoice ${check.version} is downloaded and checked.`
                : state === "installing"
                  ? "FireVoice closes and opens again by itself."
                  : `You have ${check.current}.`}
            </div>
          </div>
          {state !== "installing" && (
            <button
              type="button"
              onClick={() => (state === "downloading" || state === "ready" ? set({ folded: true }) : set({ dismissed: check.version }))}
              className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink"
              aria-label={state === "downloading" || state === "ready" ? "Fold up" : "Not now"}
            >
              {state === "downloading" || state === "ready" ? <ChevronDown className="size-4" /> : <X className="size-4" />}
            </button>
          )}
        </header>

        {check.notes && state !== "installing" && (
          <div className="border-t border-line px-4 py-2.5">
            <button type="button" onClick={() => setNotesOpen((v) => !v)} className="flex w-full items-center justify-between text-[12.5px] font-medium text-ink-2 hover:text-ink">
              What's new in {check.version}
              {notesOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </button>
            {notesOpen && (
              <div className="mt-2 max-h-[200px] overflow-y-auto rounded-lg bg-surface-2 px-3 py-2.5">
                <Markdown text={check.notes} />
              </div>
            )}
          </div>
        )}

        <div className="border-t border-line px-4 py-3.5">
          {state === "downloading" && (
            <>
              <div className="mb-1.5 flex items-baseline justify-between text-[12.5px]">
                <span className="font-medium text-ink tabular">
                  {status?.total ? `${Math.round(frac * 100)}%` : "Starting…"}
                </span>
                <span className="text-faint tabular">
                  {status && status.downloaded > 0 && `${fmtBytes(status.downloaded)}${status.total ? ` of ${fmtBytes(status.total)}` : ""}`}
                  {status && status.bytes_per_sec > 0 && ` · ${fmtBytes(status.bytes_per_sec)}/s`}
                </span>
              </div>
              <ProgressBar value={frac} />
              <p className="mt-2 text-[12px] text-muted">{eta ? `${eta[0].toUpperCase()}${eta.slice(1)}. ` : ""}Keep working; you choose when to install.</p>
            </>
          )}

          {state === "idle" && (
            <div className="flex gap-2">
              <Button size="sm" variant="primary" leading={<ArrowDownToLine className="size-3.5" />} onClick={() => void useUpdates.getState().download()}>
                Download update
              </Button>
              <Button size="sm" variant="ghost" onClick={() => set({ dismissed: check.version })}>
                Later
              </Button>
            </div>
          )}

          {state === "ready" && (
            <>
              <p className="mb-3 text-[12.5px] leading-relaxed text-muted">
                Installing takes a few seconds. Finish any render in progress first; your voices, history and settings stay as they are.
              </p>
              {installError && <p className="mb-3 text-[12.5px] text-bad">{installError}</p>}
              <div className="flex gap-2">
                <Button size="sm" variant="primary" leading={<RotateCw className="size-3.5" />} onClick={() => void useUpdates.getState().install()}>
                  Restart and install
                </Button>
                <Button size="sm" variant="ghost" onClick={() => set({ folded: true })}>
                  Later
                </Button>
              </div>
            </>
          )}

          {state === "installing" && (
            <p className="flex items-center gap-2 text-[12.5px] text-ink">
              <Loader2 className="size-4 animate-spin text-fire" /> Installing FireVoice {check.version}…
            </p>
          )}

          {state === "failed" && (
            <>
              <p className="mb-3 text-[12.5px] text-bad">{status?.error || "The update did not download."}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" leading={<RefreshCw className="size-3.5" />} onClick={() => void useUpdates.getState().download()}>
                  Try again
                </Button>
                <Button size="sm" variant="ghost" leading={<ExternalLink className="size-3.5" />} onClick={() => void openExternal(RELEASES_PAGE)}>
                  Download it yourself
                </Button>
              </div>
            </>
          )}
        </div>
      </section>
    </InCorner>
  );
}

/** The update, always in sight once its card is closed: a pill in the sidebar that opens the card again. */
export function UpdatePill({ collapsed }: { collapsed: boolean }) {
  const { check, status, installing, folded, dismissed } = useUpdates();
  const set = useUpdates((s) => s.set);
  if (!check || check.status !== "available" || !check.version) return null;
  const state = installing ? "installing" : status?.version === check.version ? status.state || "idle" : "idle";
  // while the card is open it says everything; while installing there is nothing left to choose
  if ((!folded && dismissed !== check.version) || state === "installing") return null;

  const frac = status?.total ? Math.min(1, status.downloaded / status.total) : 0;
  const label =
    state === "ready" ? "Restart to update" : state === "downloading" ? `Updating · ${Math.round(frac * 100)}%` : state === "failed" ? "Update failed · retry" : "Update available";
  const Icon = state === "ready" ? Check : state === "downloading" ? Loader2 : state === "failed" ? AlertTriangle : Sparkles;
  const tone = state === "ready" ? "bg-ok-soft text-ok hover:bg-ok-soft/70" : state === "failed" ? "bg-bad-soft text-bad hover:bg-bad-soft/70" : "bg-fire-soft text-fire hover:bg-fire-soft/70";
  const open = () => set({ dismissed: null, folded: false });

  if (collapsed) {
    return (
      <Tooltip content={`${label}: FireVoice ${check.version}`} side="right">
        <button type="button" onClick={open} aria-label={`${label}: FireVoice ${check.version}`} className={cn("relative mx-auto flex size-10 items-center justify-center rounded-[10px] transition-colors", tone)}>
          <Icon className={cn("size-[18px]", state === "downloading" && "animate-spin")} strokeWidth={state === "ready" ? 3 : 2} />
          {state === "idle" && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-fire ring-2 ring-bg-elev" />}
        </button>
      </Tooltip>
    );
  }
  return (
    <button type="button" onClick={open} aria-label={`${label}: FireVoice ${check.version}`} className={cn("relative flex w-full items-center gap-2.5 overflow-hidden rounded-[10px] px-3 py-2 text-left text-[13px] font-medium transition-colors", tone)}>
      <Icon className={cn("size-4 shrink-0", state === "downloading" && "animate-spin")} strokeWidth={state === "ready" ? 3 : 2} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[11px] font-normal tabular opacity-70">{check.version}</span>
      {state === "downloading" && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-fire/20" aria-hidden>
          <span className="block h-full bg-fire transition-[width] duration-300" style={{ width: `${frac * 100}%` }} />
        </span>
      )}
    </button>
  );
}
