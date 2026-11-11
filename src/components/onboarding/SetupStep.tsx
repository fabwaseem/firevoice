import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, Cpu, FileText, Loader2, RotateCw } from "lucide-react";
import { backend } from "@/lib/backend";
import { Button, Dialog, ProgressBar } from "@/components/ui";
import { cn } from "@/lib/utils";
import { FEATURES, StepHeader } from "./OnboardingLayout";
import { useFirstRunSetup, type Phase } from "./useFirstRunSetup";

function eta(s: number): string {
  if (s < 45) return "less than a minute left";
  if (s < 90 * 60) return `about ${Math.max(1, Math.round(s / 60))} min left`;
  return `about ${(s / 3600).toFixed(1)} h left`;
}

const gpuName = (n: string | null) => (n ? n.replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "") : null);

/** The whole setup in one place: what was found on this computer, what it needs, and how far each part is. Nothing
 * here can be skipped: when it is done the next step opens by itself, and FireVoice is ready to render. */
export function SetupStep({ onReady }: { onReady: () => void }) {
  const fr = useFirstRunSetup(true);
  const [log, setLog] = useState<string | null>(null);

  // done: carry on by itself after a moment (the latest onReady, without restarting the wait on every render)
  const next = useRef(onReady);
  next.current = onReady;
  useEffect(() => {
    if (!fr.done) return;
    const t = setTimeout(() => next.current(), 1600);
    return () => clearTimeout(t);
  }, [fr.done]);

  const hw = fr.hardware;
  const gpu = gpuName(hw?.gpu ?? null);

  return (
    <>
      <StepHeader eyebrow="Set up" title={fr.done ? "All set" : fr.progress > 0.85 ? "Almost ready" : "Setting up FireVoice for your computer"}>
        {fr.done
          ? "FireVoice is ready: your first voice is one click away."
          : "FireVoice downloads what your computer needs, once, so everything works the moment you finish. You can leave this open."}
      </StepHeader>

      {hw && (
        <div className="onb-in mb-4 rounded-2xl bg-surface-2 px-4 py-3">
          <div className="flex items-start gap-3">
            <Cpu className="mt-0.5 size-5 shrink-0 text-fire" />
            <div className="min-w-0 text-[13px]">
              <div className="font-medium text-ink">
                {gpu ?? "No NVIDIA graphics card found"}
                {hw.vram_gb ? <span className="font-normal text-muted"> · {hw.vram_gb.toFixed(0)} GB graphics memory</span> : null}
                {hw.ram_gb ? <span className="font-normal text-muted"> · {hw.ram_gb.toFixed(0)} GB RAM</span> : null}
                {hw.disk_free_gb != null ? <span className="font-normal text-muted"> · {hw.disk_free_gb.toFixed(0)} GB free</span> : null}
              </div>
              {fr.engine?.reason && <p className="mt-0.5 leading-relaxed text-muted">{fr.engine.reason}</p>}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-line bg-surface p-5">
        <div className="mb-2 flex items-baseline justify-between text-[13px]">
          <span className="font-medium text-ink tabular">{fr.done ? "Done" : `${Math.round(fr.progress * 100)}%`}</span>
          {!fr.done && fr.etaSeconds != null && <span className="text-faint tabular">{eta(fr.etaSeconds)}</span>}
        </div>
        <ProgressBar value={fr.done ? 1 : fr.progress} tone={fr.failed ? "info" : "fire"} />
        <ul className="mt-5 space-y-3.5">
          {fr.phases.map((p) => (
            <Row key={p.id} p={p} />
          ))}
        </ul>
      </div>

      {fr.failed?.error && (
        <div className="onb-in mt-4 rounded-2xl bg-bad/10 px-4 py-3.5 text-[13.5px] text-bad">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span className="break-words">{fr.failed.error}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" leading={<RotateCw className="size-3.5" />} onClick={fr.retry}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" leading={<FileText className="size-3.5" />} onClick={async () => setLog(await backend.logs(300).catch((e) => String(e)))}>
              Show the log
            </Button>
          </div>
        </div>
      )}

      {fr.done ? (
        <div className="mt-8 flex justify-center">
          <Button variant="primary" size="lg" trailing={<ArrowRight className="size-4" />} onClick={onReady}>
            Continue
          </Button>
        </div>
      ) : (
        !fr.failed && <FeatureTip />
      )}

      <Dialog open={log != null} onOpenChange={(v) => !v && setLog(null)} title="Setup log" description="Technical details that help explain what went wrong." size="xl">
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2 select-text">{log || "(empty)"}</pre>
      </Dialog>
    </>
  );
}

function Row({ p }: { p: Phase }) {
  const on = p.state === "active";
  return (
    <li className="flex items-start gap-3">
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full transition-colors",
          p.state === "done" ? "bg-ok text-white" : p.state === "failed" ? "bg-bad/15 text-bad" : on ? "bg-fire-soft text-fire" : "border border-line text-faint",
        )}
      >
        {p.state === "done" ? (
          <Check className="size-3.5" strokeWidth={3} />
        ) : p.state === "failed" ? (
          <AlertTriangle className="size-3.5" />
        ) : on ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <span className="size-1.5 rounded-full bg-current" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className={cn("text-[14px] font-medium", p.state === "waiting" ? "text-muted" : "text-ink")}>{p.label}</span>
          {on && p.frac > 0.005 && <span className="shrink-0 text-[12px] text-faint tabular">{Math.round(p.frac * 100)}%</span>}
        </span>
        <span className="block truncate text-[12.5px] text-muted" title={p.detail}>
          {p.detail}
        </span>
        {on && p.frac > 0.005 && <ProgressBar value={p.frac} className="mt-1.5 h-1" />}
      </span>
    </li>
  );
}

/** One thing FireVoice does, changing every few seconds, while the downloads run. */
function FeatureTip() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % FEATURES.length), 5500);
    return () => clearInterval(t);
  }, []);
  const f = FEATURES[i];
  return (
    <div key={i} className="onb-in mx-auto mt-6 flex max-w-[460px] items-start gap-3 text-left">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl fire-gradient text-white">
        <f.icon className="size-[18px]" />
      </span>
      <div>
        <div className="text-[13px] font-semibold text-ink">{f.title}</div>
        <p className="text-[12.5px] leading-snug text-muted">{f.text}</p>
      </div>
    </div>
  );
}
