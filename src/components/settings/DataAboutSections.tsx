import { useState } from "react";
import { BookOpen, Eraser, RotateCcw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, CardBody, CardHeader, ConfirmDialog, Skeleton } from "@/components/ui";
import { Logo } from "@/components/shell/Logo";
import { useSystem } from "@/lib/api/hooks";
import { useSettings } from "@/stores/settings";
import { SAMPLE_TEXT, useStudio } from "@/stores/studio";
import { fmtDuration } from "@/lib/utils";
import { openExternal } from "@/lib/external";

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
      <CardHeader title="Data" description="Where the server keeps voices, styles and renders." />
      <CardBody>
        {system.isLoading ? (
          <div className="space-y-3 py-1">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : s ? (
          <dl className="divide-y divide-line">
            <Row label="Home" value={s.home} mono />
            <Row label="Voices" value={s.voices_dir} mono />
            <Row label="Server version" value={s.version} />
            <Row label="Uptime" value={fmtDuration(s.uptime_seconds)} />
          </dl>
        ) : (
          <p className="py-1 text-[13px] text-muted">Connect to the server to see its data folders.</p>
        )}
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button variant="outline" size="sm" leading={<RotateCcw className="size-3.5" />} onClick={() => setConfirmDraft(true)}>
            Reset Speak draft
          </Button>
          <Button variant="outline" size="sm" leading={<Sparkles className="size-3.5" />} onClick={() => useSettings.getState().set({ onboarded: false })}>
            Show the welcome again
          </Button>
          <Button variant="danger" size="sm" leading={<Eraser className="size-3.5" />} onClick={() => setConfirmClear(true)}>
            Clear local settings
          </Button>
        </div>
      </CardBody>
      <ConfirmDialog
        open={confirmDraft}
        onOpenChange={setConfirmDraft}
        title="Reset the Speak draft?"
        description="Your script, voice, style and engine settings in Speak go back to their defaults. Nothing on the server changes."
        confirmLabel="Reset draft"
        onConfirm={resetDraft}
      />
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear local settings?"
        description="Server URL, token, theme and the Speak draft are removed from this device and the app reloads. Voices and renders stay on the server."
        confirmLabel="Clear and reload"
        destructive
        onConfirm={clearLocal}
      />
    </Card>
  );
}

export function AboutSection() {
  const serverUrl = useSettings((s) => s.serverUrl);
  return (
    <Card>
      <CardBody className="flex items-center gap-4 pt-5">
        <Logo size={44} />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold tracking-[-0.01em] text-ink">FireVoice Desktop 1.2.0</p>
          <p className="text-[12.5px] text-muted">MIT licence. Model weights carry their own licences.</p>
        </div>
        <Button variant="ghost" size="sm" leading={<BookOpen className="size-4" />} onClick={() => void openExternal(`${serverUrl}/docs`)}>
          API docs
        </Button>
      </CardBody>
    </Card>
  );
}
