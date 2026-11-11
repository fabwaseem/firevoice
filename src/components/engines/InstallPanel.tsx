import { useState } from "react";
import { Check, CircleSlash, Download, FileText, HardDriveDownload, X } from "lucide-react";
import type { Engine } from "@/lib/api/types";
import { toast } from "sonner";
import { api, downloadFile, safeFileName } from "@/lib/api/client";
import { errMessage, useActiveInstall, useInstallEngine, useInstallPlan, useJob, useUninstallEngine } from "@/lib/api/hooks";
import { Button, ConfirmDialog, Dialog, ProgressBar, Switch } from "@/components/ui";

/** What each install step is, in plain words. The plan's own text names packages, model repos and folders, which
 * the app never shows. */
const STEP_LABEL: Record<string, string> = {
  venv: "A private workspace for the engine",
  code: "The engine's program files",
  torch: "Graphics card support",
  packages: "The engine's software",
  weights: "The engine's model",
  check: "A quick check that it works",
};
const stepLabel = (step: string) => STEP_LABEL[step] ?? "Finishing touches";


/** Install, follow and remove an engine from its card. The backend does the work as an `install` job; this only
 * starts it and shows the job's progress (the jobs event feed keeps that job's cache fresh). */
export function InstallPanel({ engine, removeOpen, setRemoveOpen }: { engine: Engine; removeOpen: boolean; setRemoveOpen: (v: boolean) => void }) {
  const [planOpen, setPlanOpen] = useState(false);
  const [removeWeights, setRemoveWeights] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const active = useActiveInstall(engine.name);
  const job = useJob(jobId ?? active?.id ?? null).data ?? active;
  const install = useInstallEngine();
  const uninstall = useUninstallEngine();
  const needsPlan = planOpen || (!engine.ready && !engine.installable);
  const plan = useInstallPlan(engine.name, needsPlan);

  const running = job && (job.status === "queued" || job.status === "running");
  const failed = job && job.status === "failed";

  const saveLog = (id: string) =>
    void downloadFile(api.jobFileUrl(id, "install.log"), `${safeFileName(engine.title, "engine")} install log.txt`).catch((e) =>
      toast.error(`Could not get the log: ${errMessage(e)}`),
    );
  const cancel = (id: string) => void api.cancelJob(id).catch((e) => toast.error(errMessage(e)));

  const start = () =>
    install.mutate({ name: engine.name }, { onSuccess: (j) => { setJobId(j.id); setPlanOpen(false); } });

  return (
    <>
      {running && job && (
        <div className="mt-3 rounded-md bg-surface-2 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 text-[12.5px]">
            <span className="truncate text-ink-2">{job.message || "Starting…"}</span>
            <span className="tabular text-faint">{Math.round((job.progress ?? 0) * 100)}%</span>
          </div>
          <ProgressBar value={job.progress ?? 0} className="mt-2" />
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="ghost" leading={<X className="size-3.5" />} onClick={() => cancel(job.id)}>
              Cancel
            </Button>
            <Button size="sm" variant="ghost" leading={<FileText className="size-3.5" />} onClick={() => saveLog(job.id)}>
              Save log
            </Button>
          </div>
        </div>
      )}

      {failed && job && !engine.ready && (
        <div className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-[12px] text-muted">
          Install failed: {typeof job.error === "string" ? job.error : job.error?.message}
          <button className="ml-2 underline" onClick={() => saveLog(job.id)}>
            Save log
          </button>
        </div>
      )}

      {engine.compat?.status === "no" && !running && (
        <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-warn-soft px-3.5 py-3 text-[12.5px] leading-relaxed text-warn">
          <CircleSlash className="mt-0.5 size-4 shrink-0" />
          <span>{engine.compat.summary}</span>
        </div>
      )}

      {/* not installed yet: installing is this card's one action */}
      {!engine.ready && !running && engine.compat?.status !== "no" && (
        <div className="mt-auto flex items-center gap-3 pt-5">
          {engine.installable ? (
            <Button size="sm" variant="primary" leading={<HardDriveDownload className="size-4" />} onClick={() => setPlanOpen(true)}>
              Install
            </Button>
          ) : (
            <p className="text-[12px] text-faint">Comes with FireVoice. Reinstall FireVoice if it is missing.</p>
          )}
        </div>
      )}

      <Dialog
        open={planOpen}
        onOpenChange={setPlanOpen}
        title={`Install ${engine.title}`}
        description="FireVoice sets up everything this engine needs and downloads its voice model. It runs in the background; you can keep working."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPlanOpen(false)}>
              Not now
            </Button>
            <Button leading={<Download className="size-4" />} loading={install.isPending} disabled={!plan.data || !plan.data.uv} onClick={start}>
              Install
            </Button>
          </>
        }
      >
        {plan.isLoading && <p className="text-[13px] text-muted">Working out what to download…</p>}
        {plan.data && (
          <div className="space-y-3 text-[13px]">
            <ul className="space-y-1.5">
              {plan.data.steps.map((s, i) => (
                <li key={i} className="flex items-start gap-2">
                  {s.done ? <Check className="mt-0.5 size-4 shrink-0 text-ok" /> : <span className="mt-1.5 size-2 shrink-0 rounded-full bg-faint" />}
                  <span className={s.done ? "text-faint line-through" : "text-ink-2"}>
                    {stepLabel(s.step)}
                    {s.gb ? <span className="text-faint"> ({s.gb} GB)</span> : null}
                  </span>
                </li>
              ))}
            </ul>
            {plan.data.estimated_gb != null && (
              <p className="text-muted">
                About <b className="text-ink">{plan.data.estimated_gb} GB</b> to download, less when another engine already downloaded the same parts.
              </p>
            )}
            {plan.data.repo_code && (
              <p className="rounded-md bg-warn-soft px-3 py-2 text-warn">
                This engine runs code from its own repository, pinned to a fixed version. Install only engines you trust.
              </p>
            )}
            {!plan.data.uv && <p className="text-bad">FireVoice is missing the installer it needs for engines. Update FireVoice and try again.</p>}
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={`Remove ${engine.title}?`}
        description={
          <div className="space-y-3">
            <p>This removes the engine from this computer. You can install it again later.</p>
            <Switch checked={removeWeights} onChange={setRemoveWeights} label="Delete the downloaded model too" description="Frees several GB; a reinstall downloads it again" />
          </div>
        }
        confirmLabel="Remove"
        destructive
        loading={uninstall.isPending}
        onConfirm={() => uninstall.mutate({ name: engine.name, weights: removeWeights }, { onSettled: () => setRemoveOpen(false) })}
      />
    </>
  );
}
