import { useEffect, useState } from "react";
import { Check, Cpu, Download, Loader2, Play } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { errMessage, useHealth, useInstallEngine, useJob, useSetupReport } from "@/lib/api/hooks";
import type { EnginePick } from "@/lib/api/types";
import { useBackend } from "@/stores/backend";
import { usePlayer } from "@/stores/player";
import { useSettings } from "@/stores/settings";
import { useStudio } from "@/stores/studio";
import { Badge, Button, Dialog, ProgressBar } from "@/components/ui";
import { cn } from "@/lib/utils";

const TEST_TEXT = "Hello! This is FireVoice, speaking from your own computer. Nothing you write here leaves it.";

/** First run: what the GPU can do, one engine to start with (installed here if needed), and a test render. */
export function Welcome() {
  const onboarded = useSettings((s) => s.onboarded);
  const setSettings = useSettings((s) => s.set);
  const health = useHealth();
  const phase = useBackend((s) => s.phase);
  const open = !onboarded && health.isSuccess && phase !== "setting-up" && phase !== "starting";
  const report = useSetupReport(open);
  const qc = useQueryClient();
  const [pick, setPick] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [heard, setHeard] = useState(false);
  const install = useInstallEngine();
  const job = useJob(jobId).data;
  const r = report.data;

  useEffect(() => {
    if (r && !pick) setPick(r.recommended.engine);
  }, [r, pick]);

  const options: EnginePick[] = r ? [r.recommended, ...r.alternatives] : [];
  const chosen = options.find((o) => o.engine === pick) ?? r?.recommended;
  const installing = job && (job.status === "queued" || job.status === "running");
  const installed = chosen?.ready || job?.status === "done";

  useEffect(() => {
    if (job?.status === "done") {
      void qc.invalidateQueries({ queryKey: ["setup-report"] });
      void qc.invalidateQueries({ queryKey: ["engines"] });
      void qc.invalidateQueries({ queryKey: ["options"] });
    }
  }, [job?.status, qc]);

  const finish = () => {
    if (chosen && installed) useStudio.getState().set({ engine: chosen.engine });
    setSettings({ onboarded: true });
  };

  const test = async () => {
    if (!chosen) return;
    setTesting(true);
    try {
      const res = await api.tts({ text: TEST_TEXT, engine: chosen.engine, style: "conversational" });
      const src = URL.createObjectURL(res.blob);
      usePlayer.getState().load({ id: `welcome-${Date.now()}`, title: "Welcome to FireVoice", subtitle: chosen.title, src, blob: res.blob, duration: res.duration });
      setHeard(true);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && setSettings({ onboarded: true })}
      title="Welcome to FireVoice"
      description="A quick check of this computer, an engine to start with, and your first line of speech."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => setSettings({ onboarded: true })}>
            Skip
          </Button>
          <Button onClick={finish} disabled={!!installing}>
            {heard ? "Start creating" : "Done"}
          </Button>
        </>
      }
    >
      {!r ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
          <Loader2 className="size-4 animate-spin" /> Checking this computer…
        </div>
      ) : (
        <div className="space-y-5">
          <section className="flex items-start gap-3 rounded-lg bg-surface-2 px-4 py-3">
            <Cpu className="mt-0.5 size-5 shrink-0 text-fire" />
            <div className="text-[13px]">
              <p className="font-medium text-ink">{r.gpu?.name ?? "No NVIDIA GPU found"}</p>
              <p className="text-muted">
                {r.vram_gb ? `${r.vram_gb.toFixed(1)} GB of video memory` : "FireVoice will use the CPU, which suits the smallest engine."}
                {" · "}
                {r.voices} voices in your library
                {r.ffmpeg ? "" : " · ffmpeg missing"}
              </p>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[12px] font-semibold tracking-[0.08em] text-faint uppercase">Your first engine</h3>
            <div className="space-y-2">
              {options.map((o, i) => (
                <button
                  key={o.engine}
                  type="button"
                  disabled={!!installing}
                  onClick={() => setPick(o.engine)}
                  className={cn(
                    "w-full rounded-lg border px-4 py-3 text-left transition-colors",
                    pick === o.engine ? "border-fire bg-fire-soft/40" : "border-line hover:border-line-strong",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-ink">{o.title}</span>
                    {i === 0 && <Badge tone="fire">Recommended</Badge>}
                    {o.ready ? <Badge tone="ok">ready</Badge> : o.installable ? <Badge tone="neutral">download</Badge> : <Badge tone="warn">manual install</Badge>}
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{o.reason}</p>
                </button>
              ))}
            </div>
            {chosen && !installed && chosen.installable && !installing && (
              <Button
                className="mt-3"
                size="sm"
                leading={<Download className="size-4" />}
                loading={install.isPending}
                onClick={() => install.mutate({ name: chosen.engine }, { onSuccess: (j) => setJobId(j.id) })}
              >
                Install {chosen.title}
              </Button>
            )}
            {installing && job && (
              <div className="mt-3">
                <ProgressBar value={job.progress ?? 0} />
                <p className="mt-1.5 truncate text-[12px] text-muted">{job.message || "Starting…"}</p>
              </div>
            )}
            {job?.status === "failed" && <p className="mt-2 text-[12.5px] text-bad">{typeof job.error === "string" ? job.error : job.error?.message}</p>}
          </section>

          <section>
            <h3 className="mb-2 text-[12px] font-semibold tracking-[0.08em] text-faint uppercase">Hear it</h3>
            <div className="flex items-center gap-3">
              <Button size="sm" variant="soft" leading={heard ? <Check className="size-4" /> : <Play className="size-4" />} disabled={!installed || !!installing} loading={testing} onClick={test}>
                {heard ? "Play again" : "Say hello"}
              </Button>
              <span className="text-[12.5px] text-faint">The first line loads the engine, so it takes a little longer.</span>
            </div>
          </section>
        </div>
      )}
    </Dialog>
  );
}
