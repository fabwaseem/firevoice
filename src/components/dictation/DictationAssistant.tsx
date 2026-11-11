import { useEffect, useState } from "react";
import { Briefcase, Code2, Cpu, Download, FileText, Mail, MessageCircle, MousePointerClick, Sparkles, SquareDashed, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { errMessage, useJobs } from "@/lib/api/hooks";
import { inTauri } from "@/lib/backend";
import { hotkeyLabels } from "@/lib/dictation";
import { cn } from "@/lib/utils";
import { jobActive, jobError, useLiveJob } from "@/components/onboarding/useLiveJob";
import { Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, Kbd, ProgressBar, Segmented, Switch } from "@/components/ui";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { useDictation, type AppKind, type WritingStyle } from "@/stores/dictation";

export const ASSISTANT_KEY = ["dictation-assistant"];

export function useAssistant() {
  return useQuery({ queryKey: ASSISTANT_KEY, queryFn: api.dictationAssistant, staleTime: 15_000 });
}

const KINDS: { kind: AppKind; label: string; hint: string; icon: typeof Mail }[] = [
  { kind: "messages", label: "Personal messages", hint: "WhatsApp, Telegram, Discord, Messenger", icon: MessageCircle },
  { kind: "work chat", label: "Work chat", hint: "Slack, Teams, Google Chat", icon: Briefcase },
  { kind: "email", label: "Email", hint: "Outlook, Gmail, Thunderbird", icon: Mail },
  { kind: "documents", label: "Documents", hint: "Word, Google Docs, Notion, Obsidian", icon: FileText },
  { kind: "code", label: "Code and terminals", hint: "VS Code, Cursor, JetBrains, terminals", icon: Code2 },
  { kind: "other", label: "Everything else", hint: "Any other app", icon: SquareDashed },
];

const STYLE_OPTIONS: { value: WritingStyle; label: string }[] = [
  { value: "formal", label: "Formal" },
  { value: "casual", label: "Casual" },
  { value: "very casual", label: "Very casual" },
];

const EXAMPLE: Record<WritingStyle, string> = {
  formal: "Hey, are you free for lunch tomorrow? Let me know.",
  casual: "Hey, are you free for lunch tomorrow? Let me know",
  "very casual": "hey are you free for lunch tomorrow? let me know",
  code: "Run npm install, then open src/index.ts",
};

/** Dictation's writing assistant: install it, then choose how dictations are written per app, and command mode. */
export function DictationAssistantPanel() {
  const config = useDictation((s) => s.config);
  const set = useDictation((s) => s.set);
  const st = useAssistant();
  const ready = !!st.data?.installed;

  return (
    <div className="flex flex-col gap-4">
      <InstallCard />

      <Card className={cn(!ready && "opacity-60")}>
        <CardHeader
          title="Polish my dictations"
          description="Fixes punctuation and grammar, removes false starts, applies “no wait…” corrections and lays out lists, in the style of the app you are writing in."
          action={<Switch checked={config.polish} onChange={(v) => set({ polish: v })} disabled={!ready} />}
        />
        <CardBody className="space-y-1">
          {config.mode !== "onstop" && (
            <p className="mb-3 rounded-[10px] bg-info-soft px-3 py-2 text-[12.5px] text-info">
              Polishing works when words appear <b>when you stop</b> (Setup tab): live typing cannot rewrite what is already typed.
            </p>
          )}
          <ul className="divide-y divide-line">
            {KINDS.map(({ kind, label, hint, icon: Icon }) => {
              const value = config.styles[kind];
              return (
                <li key={kind} className="flex items-center gap-3 py-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-surface-2 text-muted">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">{label}</div>
                    <div className="truncate text-[12px] text-faint">{hint}</div>
                  </div>
                  {kind === "code" ? (
                    <Badge tone="neutral">Keeps code as said</Badge>
                  ) : (
                    <Segmented<WritingStyle>
                      ariaLabel={`Style for ${label}`}
                      size="sm"
                      value={value === "code" ? "formal" : value}
                      onChange={(v) => set({ styles: { ...config.styles, [kind]: v } })}
                      options={STYLE_OPTIONS}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-2 grid grid-cols-1 gap-2 rounded-[12px] bg-surface-2 p-3 text-[12.5px] sm:grid-cols-3">
            {(["formal", "casual", "very casual"] as const).map((s) => (
              <div key={s}>
                <div className="text-[11px] font-semibold tracking-wide text-faint uppercase">{s}</div>
                <div className="mt-0.5 text-ink-2">{EXAMPLE[s]}</div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      <CommandModeCard ready={ready} />
    </div>
  );
}

function InstallCard() {
  const qc = useQueryClient();
  const st = useAssistant();
  // the install is a server job: follow the one that is running, whichever page or click started it
  const writerJobs = useJobs({ kind: "writer", limit: 3 });
  const latest = writerJobs.data?.jobs?.[0] ?? null;
  const [jobId, setJobId] = useState<string | null>(null);
  const followed = jobId ?? (latest && jobActive(latest) ? latest.id : null);
  const job = useLiveJob(followed) ?? (latest && latest.id === followed ? latest : undefined);
  const running = jobActive(job);
  const error = jobId ? jobError(job) : null;
  const install = useMutation({
    mutationFn: api.installAssistant,
    onSuccess: (j) => {
      setJobId(j.id);
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (e) => toast.error(errMessage(e)),
  });
  const [removing, setRemoving] = useState(false);
  const remove = useMutation({
    mutationFn: api.removeAssistant,
    onSuccess: (s) => {
      setRemoving(false);
      qc.setQueryData(ASSISTANT_KEY, s);
    },
    onError: (e) => toast.error(errMessage(e)),
  });
  useEffect(() => {
    if (job?.status === "done") void qc.invalidateQueries({ queryKey: ASSISTANT_KEY });
  }, [job?.status, qc]);
  const s = st.data;
  return (
    <Card raised>
      <CardBody className="pt-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-[12px] fire-gradient text-white">
              <Sparkles className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-[16px] font-semibold text-ink">Writing assistant</h2>
                {s?.installed ? <Badge tone="ok" dot>Installed</Badge> : <Badge tone="neutral">Not installed</Badge>}
                {s?.loaded && (
                  <Badge tone="info">
                    <Cpu className="size-3" /> {s.device === "gpu" ? "On your graphics card" : "On your processor"}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">
                A small writing model that runs on this computer, like the voice engines. It turns what you say into what you meant to write, and edits
                text by voice. Nothing leaves your computer. It adds about a tenth of a second on a graphics card, a second or two on a processor.
              </p>
              {s && !s.supported && <p className="mt-1 text-[12.5px] text-warn">It runs on Windows and Linux.</p>}
            </div>
          </div>
          {!s?.installed && !running && (
            <Button leading={<Download className="size-4" />} loading={install.isPending} disabled={s ? !s.supported : false} onClick={() => install.mutate()}>
              Install{s ? ` (${s.size_gb.toFixed(1)} GB)` : ""}
            </Button>
          )}
          {s?.installed && (
            <Button variant="ghost" size="sm" leading={<Trash2 className="size-4" />} onClick={() => setRemoving(true)}>
              Remove
            </Button>
          )}
        </div>
        {running && job && (
          <div className="mt-4">
            <div className="mb-1.5 flex justify-between text-[12.5px] text-muted">
              <span className="truncate">{job.message || "Starting…"}</span>
              <span className="tabular">{Math.round((job.progress ?? 0) * 100)}%</span>
            </div>
            <ProgressBar value={job.progress ?? 0} />
          </div>
        )}
        {error && <p className="mt-3 rounded-[10px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</p>}
      </CardBody>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove the writing assistant?"
        description="Its model is deleted from this computer (2.5 GB freed). Dictation keeps working without polishing and command mode; you can install it again any time."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  );
}

function CommandModeCard({ ready }: { ready: boolean }) {
  const config = useDictation((s) => s.config);
  const set = useDictation((s) => s.set);
  const desktop = inTauri();
  const on = !!config.commandHotkey;
  return (
    <Card className={cn(!ready && "opacity-60")}>
      <CardHeader
        title="Command mode"
        description="Select text in any app, press the command keys and say what to do with it. With nothing selected, it writes what you ask for."
        action={<Switch checked={on} onChange={(v) => set({ commandHotkey: v ? "Ctrl+Alt+Shift+Space" : "" })} disabled={!ready} />}
      />
      <CardBody className="space-y-4">
        {on && (
          <div className="flex items-center justify-between gap-6">
            <div>
              <span className="block text-[13px] font-medium text-ink">Command keys</span>
              <span className="block text-[12px] text-muted">Works the same way as the dictation keys (press or hold).</span>
            </div>
            <HotkeyRecorder value={config.commandHotkey} onChange={(commandHotkey) => set({ commandHotkey })} disabled={!desktop || !ready} />
          </div>
        )}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[
            "Make this more polite",
            "Turn this into bullet points",
            "Translate to Spanish",
            "Fix the grammar",
            "Make it shorter",
            "Write a friendly reply saying I'll be there",
          ].map((ex) => (
            <div key={ex} className="flex items-center gap-2 rounded-[10px] bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
              <MousePointerClick className="size-3.5 shrink-0 text-faint" /> “{ex}”
            </div>
          ))}
        </div>
        {on && (
          <p className="text-[12px] text-faint">
            Select the text, press{" "}
            {hotkeyLabels(config.commandHotkey).map((k, i) => (
              <Kbd key={i}>{k}</Kbd>
            ))}{" "}
            and speak. The result replaces the selection.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
