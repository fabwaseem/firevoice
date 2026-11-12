import { useEffect, useState } from "react";
import { Compass, Eraser, RefreshCw, RotateCcw, Sparkles } from "@/components/icons";
import { useUpdates } from "@/components/shell/UpdateGate";
import { useTour } from "@/components/tour/Tour";
import { toast } from "sonner";
import { Button, Card, CardBody, CardHeader, ConfirmDialog, Skeleton } from "@/components/ui";
import { Logo } from "@/components/shell/Logo";
import { useSystem } from "@/lib/api/hooks";
import { useSettings } from "@/stores/settings";
import { SAMPLE_TEXT, useStudio } from "@/stores/studio";
import { fmtDuration } from "@/lib/utils";
import { inTauri } from "@/lib/backend";
import pkg from "../../../package.json";
import { EngineLogButton } from "./EngineLog";

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2 text-[13px]">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className={mono ? "truncate font-mono text-[12.5px] text-ink-2" : "truncate text-ink"} title={typeof value === "string" ? value : undefined}>
        {value}
      </dd>
    </div>
  );
}

export function DataSection() {
  const system = useSystem();
  const [confirmDraft, setConfirmDraft] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const s = system.data;

  const resetDraft = () => {
    useStudio.getState().set({
      text: SAMPLE_TEXT, engine: null, voice: "default", style: "conversational", pace: 1, seed: 1234, language: null, instruct: null,
      params: {}, styleOverrides: {}, candidates: 1, accept: 0.9, validate: true, lufs: -16, leadMs: 120, tailMs: 280, sampleRate: null,
    });
    setConfirmDraft(false);
    toast.success("Speak draft reset");
  };

  const clearLocal = () => {
    localStorage.removeItem("firevoice.settings");
    localStorage.removeItem("firevoice.studio");
    window.location.reload();
  };

  return (
    <Card>
      <CardHeader title="Data" description="Where FireVoice keeps your voices, styles and renders." />
      <CardBody>
        {system.isLoading ? (
          <div className="space-y-3 py-1">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : s ? (
          <dl className="divide-y divide-line">
            <Row label="Data folder" value={s.home} mono />
            <Row label="Voices folder" value={s.voices_dir} mono />
            <Row label="Voice engine version" value={s.version} />
            <Row label="Running for" value={fmtDuration(s.uptime_seconds)} />
          </dl>
        ) : (
          <p className="py-1 text-[13px] text-muted">Connect to FireVoice to see where your data is kept.</p>
        )}
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button variant="outline" size="sm" leading={<RotateCcw className="size-3.5" />} onClick={() => setConfirmDraft(true)}>
            Reset Speak draft
          </Button>
          <Button variant="outline" size="sm" leading={<Sparkles className="size-3.5" />} onClick={() => useSettings.getState().set({ onboarded: false })}>
            Show the welcome again
          </Button>
          <Button variant="outline" size="sm" leading={<Compass className="size-3.5" />} onClick={() => useTour.getState().start()}>
            Take the tour
          </Button>
          {inTauri() && (
            <Button variant="outline" size="sm" leading={<RefreshCw className="size-3.5" />} onClick={() => void useUpdates.getState().runCheck(true)}>
              Check for updates
            </Button>
          )}
          <Button variant="danger" size="sm" leading={<Eraser className="size-3.5" />} onClick={() => setConfirmClear(true)}>
            Clear local settings
          </Button>
        </div>
      </CardBody>
      <ConfirmDialog
        open={confirmDraft}
        onOpenChange={setConfirmDraft}
        title="Reset the Speak draft?"
        description="Your script, voice, style and engine settings in Speak go back to their defaults. Your voices and renders are not touched."
        confirmLabel="Reset draft"
        onConfirm={resetDraft}
      />
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear local settings?"
        description="The server address, access key, theme and the Speak draft are removed from this device and the app reloads. Your voices and renders are kept."
        confirmLabel="Clear and reload"
        destructive
        onConfirm={clearLocal}
      />
    </Card>
  );
}

export function AboutSection() {
  const [version, setVersion] = useState<string>(pkg.version);
  useEffect(() => {
    if (!inTauri()) return;
    let alive = true;
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => alive && v && setVersion(v))
      .catch(() => {
        /* keep the package version */
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Card>
      <CardBody className="flex items-center gap-4 pt-5">
        <Logo size={44} />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold tracking-[-0.01em] text-ink">FireVoice {version}</p>
          <p className="text-[12.5px] text-muted">Natural voices, made on your own computer.</p>
        </div>
        <EngineLogButton variant="outline" />
      </CardBody>
    </Card>
  );
}
