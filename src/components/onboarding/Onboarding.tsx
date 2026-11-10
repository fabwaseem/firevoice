import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, Compass, Cpu, Download, FileText, HardDrive, Keyboard, Loader2, Lock, Mic, Play, Rocket, RotateCw,
  Sparkles, Square, Volume2, VolumeX, Zap,
} from "lucide-react";
import { BackgroundSetup } from "@/components/shell/BackgroundSetup";
import { HotkeyRecorder } from "@/components/dictation/HotkeyRecorder";
import { useTour } from "@/components/tour/Tour";
import { startAmbient, stopAmbient } from "./ambient";
import { api } from "@/lib/api/client";
import { errMessage, useHealth, useInstallEngine, useJob, useSetupReport, useVoices } from "@/lib/api/hooks";
import type { EnginePick, Job } from "@/lib/api/types";
import { backend, inTauri } from "@/lib/backend";
import { dictation, hotkeyLabels } from "@/lib/dictation";
import { useBackend } from "@/stores/backend";
import { useDictation, useDictationLive, type DictationConfig } from "@/stores/dictation";
import { useSettings } from "@/stores/settings";
import { useStudio } from "@/stores/studio";
import { AudioPlayer, Badge, Button, Dialog, Kbd, ProgressBar, Segmented, Select, Switch, Textarea } from "@/components/ui";
import { Logo } from "@/components/shell/Logo";
import { cn } from "@/lib/utils";
import { FEATURES, OnboardingFrame, StepHeader, Waveform, type StepInfo } from "./OnboardingLayout";

const HELLO = "Hello! This is FireVoice, speaking from your own computer. Everything you write stays right here.";

type StepId = "welcome" | "setup" | "engine" | "voice" | "dictation" | "ready";

/* ------------------------------------------------------------------------------------------------------------------
 * The whole first run: welcome, the quick setup (only while this computer still needs it), choose an engine, first
 * words, dictation, and a last screen that opens the app (with an optional tour). It stays on screen until the user
 * finishes it or presses "Skip to app"; nothing moves on behind their back.
 * ---------------------------------------------------------------------------------------------------------------- */
export function Onboarding() {
  const info = useBackend((s) => s.info);
  const phase = useBackend((s) => s.phase);
  const [step, setStep] = useState<StepId>("welcome");
  // the setup step is listed only on computers that need it (it stays listed once it was needed)
  const needed = inTauri() && (phase === "needs-setup" || phase === "setting-up" || phase === "failed" || (!!info && info.mode === "bundled" && !info.ready));
  const neededOnce = useRef(false);
  if (needed) neededOnce.current = true;
  const steps: StepInfo[] = [
    { id: "welcome", title: "Welcome" },
    ...(neededOnce.current ? [{ id: "setup", title: "Get ready" }] : []),
    { id: "engine", title: "Engine" },
    { id: "voice", title: "First words" },
    { id: "dictation", title: "Dictation" },
    { id: "ready", title: "Ready" },
  ];
  const [engine, setEngine] = useState<string | null>(null);
  const [installJob, setInstallJob] = useState<string | null>(null);
  const music = useSetupMusic();
  const health = useHealth();
  // the quick setup often finishes while the welcome screen is still up: then there is nothing to wait for
  const coreReady = health.isSuccess && phase === "idle";

  const finish = (tour: boolean) => {
    music.stop();
    if (engine) useStudio.getState().set({ engine });
    if (tour) useTour.getState().queue();
    useSettings.getState().set({ onboarded: true });
  };

  // the engine stopped or needs (re)installing part way through: show that, then carry on where the user was
  const blocked = inTauri() && (phase === "failed" || phase === "needs-setup" || phase === "setting-up" || phase === "starting");
  const current: StepId = step !== "welcome" && blocked ? "setup" : step;

  const actions = (
    <>
      <MusicToggle music={music} />
      <Button variant="ghost" size="sm" trailing={<ArrowRight className="size-3.5" />} onClick={() => finish(false)}>
        Skip to app
      </Button>
    </>
  );

  if (current === "welcome") {
    return (
      <OnboardingFrame wide actions={actions}>
        <WelcomeHero
          onStart={() => {
            music.startIfOn();
            setStep(coreReady || !(blocked || neededOnce.current) ? "engine" : "setup");
          }}
        />
      </OnboardingFrame>
    );
  }
  return (
    <>
      <OnboardingFrame steps={steps} current={current} actions={actions}>
        {current === "setup" && <SetupPanel onReady={step === "setup" ? () => setStep("engine") : undefined} />}
        {current === "engine" && (
          <EngineStep
            jobId={installJob}
            onJob={setInstallJob}
            onNext={(e) => {
              setEngine(e);
              setStep("voice");
            }}
            onSkip={() => setStep("dictation")}
          />
        )}
        {current === "voice" && <FirstWords engine={engine} jobId={installJob} onNext={() => setStep("dictation")} onBack={() => setStep("engine")} />}
        {current === "dictation" && <DictationStep onNext={() => setStep("ready")} onBack={() => setStep(engine ? "voice" : "engine")} />}
        {current === "ready" && <ReadyStep engine={engine} jobId={installJob} onFinish={finish} onBack={() => setStep("dictation")} />}
      </OnboardingFrame>
      {current !== "setup" && <BackgroundSetup startFolded />}
    </>
  );
}

/** A row of step buttons, centred under the content. */
function StepActions({ children, onBack }: { children: React.ReactNode; onBack?: () => void }) {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
      {onBack && (
        <Button variant="ghost" size="lg" leading={<ArrowLeft className="size-4" />} onClick={onBack}>
          Back
        </Button>
      )}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------- music ---- */

function useSetupMusic() {
  const on = useSettings((s) => s.setupMusic);
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => stopAmbient(), []);
  return {
    on,
    playing,
    startIfOn: () => {
      if (!useSettings.getState().setupMusic) return;
      startAmbient();
      setPlaying(true);
    },
    stop: () => {
      stopAmbient();
      setPlaying(false);
    },
    toggle: () => {
      if (playing) {
        stopAmbient();
        setPlaying(false);
        useSettings.getState().set({ setupMusic: false });
      } else {
        useSettings.getState().set({ setupMusic: true });
        startAmbient();
        setPlaying(true);
      }
    },
  };
}

function MusicToggle({ music }: { music: ReturnType<typeof useSetupMusic> }) {
  return (
    <button
      type="button"
      onClick={music.toggle}
      className="flex h-8 items-center gap-2 rounded-full border border-line bg-surface/70 pr-3.5 pl-2.5 text-[12.5px] font-medium text-muted backdrop-blur-sm transition-colors hover:text-ink"
      aria-pressed={music.playing}
      title={music.playing ? "Turn the music off" : "Play some calm music while FireVoice gets ready"}
    >
      {music.playing ? <Volume2 className="size-4 text-fire" /> : <VolumeX className="size-4" />}
      {music.playing ? "Music on" : "Music off"}
    </button>
  );
}

/** An engine install job, kept fresh while it runs (the app's job feed is not running yet during the first run). */
function useLiveJob(id: string | null): Job | undefined {
  const q = useJob(id);
  const job = q.data;
  const active = !!job && (job.status === "queued" || job.status === "running");
  const { refetch } = q;
  useEffect(() => {
    if (!id || (job && !active)) return;
    const t = setInterval(() => void refetch(), 1500);
    return () => clearInterval(t);
  }, [id, job, active, refetch]);
  return job;
}

const jobActive = (j?: Job) => !!j && (j.status === "queued" || j.status === "running");

function InstallProgress({ job, title }: { job: Job; title: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-2 flex items-baseline justify-between text-[13px]">
        <span className="flex items-center gap-2 font-medium text-ink">
          <Loader2 className="size-4 animate-spin text-fire" /> Installing {title}
        </span>
        <span className="text-faint tabular">{Math.round((job.progress ?? 0) * 100)}%</span>
      </div>
      <ProgressBar value={job.progress ?? 0} />
      <p className="mt-2 truncate text-[12.5px] text-muted" title={job.message ?? undefined}>{job.message || "Starting…"}</p>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- 1. welcome ---- */

function WelcomeHero({ onStart }: { onStart: () => void }) {
  const phase = useBackend((s) => s.phase);
  const setup = useBackend((s) => s.setup);
  const health = useHealth();
  // the quick setup already runs behind this screen: say so, quietly
  const status =
    phase === "setting-up"
      ? `Preparing FireVoice in the background · ${Math.round(Math.min(0.95, ((setup?.step ?? 0) + 0.5) / (setup?.steps ?? 3)) * 100)}%`
      : phase === "starting"
        ? "Starting FireVoice…"
        : inTauri() && health.isSuccess && phase === "idle"
          ? "FireVoice is ready"
          : null;
  return (
    <div className="text-center">
      <div className="onb-rise mx-auto mb-6 w-fit rounded-[22px] onb-glow">
        <Logo size={68} />
      </div>
      <h1 className="onb-rise text-[42px] leading-[1.05] font-semibold tracking-[-0.035em] text-ink" style={{ animationDelay: "80ms" }}>
        Natural voices,
        <br />
        <span className="bg-gradient-to-r from-fire-2 to-fire bg-clip-text text-transparent">made on your own computer.</span>
      </h1>
      <p className="onb-rise mx-auto mt-4 max-w-[640px] text-[15.5px] leading-relaxed text-muted" style={{ animationDelay: "160ms" }}>
        FireVoice turns text into expressive speech, copies and designs voices, types what you say in any program, dubs, transcribes and
        makes sound, all on your graphics card. Private, fast, and yours.
      </p>

      <div className="mt-8 grid grid-cols-2 gap-3 text-left md:grid-cols-4">
        {FEATURES.map((f, i) => (
          <div
            key={f.title}
            className="onb-rise group rounded-2xl border border-line bg-surface/70 p-4 backdrop-blur-sm transition-colors hover:border-fire/40"
            style={{ animationDelay: `${240 + i * 55}ms` }}
          >
            <span className="mb-3 flex size-9 items-center justify-center rounded-xl bg-fire-soft text-fire transition-colors group-hover:fire-gradient group-hover:text-white">
              <f.icon className="size-[18px]" />
            </span>
            <div className="text-[14px] font-semibold text-ink">{f.title}</div>
            <p className="mt-1 text-[12.5px] leading-snug text-muted">{f.text}</p>
          </div>
        ))}
      </div>

      <div className="onb-rise mt-8 flex flex-col items-center gap-3" style={{ animationDelay: "720ms" }}>
        <Button size="lg" variant="primary" className="h-12 px-8 text-[15px]" trailing={<ArrowRight className="size-4" />} onClick={onStart}>
          Get started
        </Button>
        <p className="flex items-center gap-1.5 text-[12.5px] text-faint">
          <Lock className="size-3.5" /> About two minutes. Nothing you make ever leaves this computer.
        </p>
        {status && (
          <p className="onb-in flex items-center gap-2 rounded-full bg-surface/70 px-3 py-1 text-[12px] text-muted backdrop-blur-sm">
            {status === "FireVoice is ready" ? <Check className="size-3.5 text-ok" strokeWidth={3} /> : <Loader2 className="size-3.5 animate-spin text-fire" />}
            {status}
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ 2. set up ---- */

/** The quick setup's steps, by how many the shell reports: 3 on a first run (the big downloads come later, in the
 * background), 4 when an app update brings everything in step before the engine starts. */
const SETUP_STEPS: Record<number, { title: string; text: string }[]> = {
  3: [
    { title: "Runtime", text: "A private space for FireVoice to run in" },
    { title: "FireVoice", text: "The app's own engine, without the heavy parts" },
    { title: "Final check", text: "Making sure it starts" },
  ],
  4: [
    { title: "Runtime", text: "A private space for FireVoice to run in" },
    { title: "FireVoice", text: "The new version of the app's engine" },
    { title: "Voice libraries", text: "Bringing the rest up to date" },
    { title: "Final check", text: "Making sure everything works together" },
  ],
};

function useElapsed(running: boolean) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t0 = Date.now();
    const t = setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);
  return s;
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** The one-time setup of the engine's runtime, start to finish: what it installs, live progress, and what to do if it
 * fails. Also used on its own when an update brings a new engine or the engine cannot start. */
export function SetupPanel({ onReady, updating }: { onReady?: () => void; updating?: boolean }) {
  const { phase, setup, error, info } = useBackend();
  const health = useHealth();
  const elapsed = useElapsed(phase === "setting-up" || phase === "starting");
  const [log, setLog] = useState<string | null>(null);
  // ready means the engine answers and nothing is pending (a setup that is still needed or failed is not ready)
  const ready = health.isSuccess && phase === "idle";

  // once ready, move on by itself after a moment (the latest onReady, without restarting the wait on every render)
  const next = useRef(onReady);
  next.current = onReady;
  useEffect(() => {
    if (!ready || !next.current) return;
    const t = setTimeout(() => next.current?.(), 1200);
    return () => clearTimeout(t);
  }, [ready]);

  const showLog = async () => setLog(await backend.logs(300).catch((e) => String(e)));
  const retry = () => (info?.ready && !updating ? useBackend.getState().start() : useBackend.getState().runSetup());

  if (phase === "failed") {
    return (
      <>
        <StepHeader eyebrow="Set up" title="Something stopped the setup">
          Nothing is lost: try again, and FireVoice picks up where it left off.
        </StepHeader>
        <div className="flex items-start gap-3 rounded-2xl bg-bad/10 px-4 py-3.5 text-[13.5px] text-bad">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{error || "The setup did not finish."}</span>
        </div>
        <StepActions>
          <Button variant="primary" size="lg" leading={<RotateCw className="size-4" />} onClick={() => void retry()}>
            Try again
          </Button>
          <Button variant="ghost" size="lg" leading={<FileText className="size-4" />} onClick={() => void showLog()}>
            Show the log
          </Button>
        </StepActions>
        <LogDialog log={log} onClose={() => setLog(null)} />
      </>
    );
  }

  if (phase === "setting-up" || phase === "starting" || ready) {
    const total = setup?.steps ?? 3;
    const list = SETUP_STEPS[total] ?? SETUP_STEPS[4];
    const at = ready ? total : phase === "starting" ? total : Math.min(setup?.step ?? 0, total - 1);
    const frac = ready ? 1 : phase === "starting" ? 0.97 : Math.min(0.95, ((setup?.step ?? 0) + 0.5) / total);
    return (
      <>
        <StepHeader
          eyebrow={updating ? "Update" : "Get ready"}
          title={ready ? "All set" : phase === "starting" ? "Starting FireVoice" : updating ? "Updating FireVoice" : "Getting FireVoice ready"}
        >
          {ready
            ? "FireVoice is ready on this computer."
            : phase === "starting"
              ? "Almost there: FireVoice is waking up."
              : updating
                ? "A minute or two, once per update. Your voices, history and settings stay as they are."
                : "About a minute. The big downloads (graphics card support) carry on in the background while you continue."}
        </StepHeader>
        {!ready && !updating && <Waveform bars={34} className="mx-auto mb-6 h-10 w-fit" />}
        <div className="rounded-2xl border border-line bg-surface p-5">
          <div className="mb-2 flex items-baseline justify-between text-[13px]">
            <span className="font-medium text-ink">{ready ? "Done" : `${Math.round(frac * 100)}%`}</span>
            {!ready && <span className="text-faint tabular">{mmss(elapsed)}</span>}
          </div>
          <ProgressBar value={frac} />
          <ul className="mt-5 space-y-3">
            {list.map((s, n) => {
              const done = n < at || ready;
              const on = !done && n === at && phase === "setting-up";
              return (
                <li key={s.title} className="flex items-start gap-3">
                  <span
                    className={cn(
                      "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full transition-colors",
                      done ? "bg-ok text-white" : on ? "bg-fire-soft text-fire" : "border border-line text-faint",
                    )}
                  >
                    {done ? <Check className="size-3.5" strokeWidth={3} /> : on ? <Loader2 className="size-3.5 animate-spin" /> : <span className="size-1.5 rounded-full bg-current" />}
                  </span>
                  <span className="min-w-0">
                    <span className={cn("block text-[14px] font-medium", done || on ? "text-ink" : "text-muted")}>{s.title}</span>
                    <span className="block truncate text-[12.5px] text-muted" title={on ? setup?.message : undefined}>
                      {on && setup?.message ? setup.message : s.text}
                    </span>
                  </span>
                </li>
              );
            })}
            {phase === "starting" && (
              <li className="flex items-center gap-3 text-[13.5px] text-ink">
                <Loader2 className="size-5 animate-spin text-fire" /> Starting the voice engine…
              </li>
            )}
          </ul>
        </div>
        {ready && onReady && (
          <StepActions>
            <Button variant="primary" size="lg" trailing={<ArrowRight className="size-4" />} onClick={onReady}>
              Continue
            </Button>
          </StepActions>
        )}
      </>
    );
  }

  // needs setup: what it is, then one button
  return (
    <>
      <StepHeader eyebrow={updating ? "Update" : "Get ready"} title={updating ? "Update the voice engine" : "Set up FireVoice on this computer"}>
        FireVoice runs entirely on your computer, so it needs a few parts the first time. They install once; after that it starts in
        seconds.
      </StepHeader>
      <div className="space-y-2.5">
        {[
          { icon: HardDrive, title: "About 100 MB to start", text: "The rest (up to 4 GB) downloads in the background while you continue." },
          { icon: Cpu, title: "Uses your graphics card", text: "That's what makes voices fast and natural." },
          { icon: Lock, title: "Stays on this computer", text: "Your voices, scripts and recordings are never uploaded." },
        ].map((r) => (
          <div key={r.title} className="flex items-center gap-3.5 rounded-2xl border border-line bg-surface px-4 py-3.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-fire-soft text-fire">
              <r.icon className="size-[18px]" />
            </span>
            <span>
              <span className="block text-[14px] font-medium text-ink">{r.title}</span>
              <span className="block text-[12.5px] text-muted">{r.text}</span>
            </span>
          </div>
        ))}
      </div>
      <StepActions>
        <Button variant="primary" size="lg" leading={<Rocket className="size-4" />} onClick={() => void useBackend.getState().runSetup()}>
          Set up now
        </Button>
      </StepActions>
    </>
  );
}

function LogDialog({ log, onClose }: { log: string | null; onClose: () => void }) {
  return (
    <Dialog open={log != null} onOpenChange={(v) => !v && onClose()} title="Engine log" description="Technical details that help explain what went wrong." size="xl">
      <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2 select-text">{log || "(empty)"}</pre>
    </Dialog>
  );
}

/* ---------------------------------------------------------------------------------------------- 3. engine ---- */

function EngineStep({
  jobId,
  onJob,
  onNext,
  onSkip,
}: {
  jobId: string | null;
  onJob: (id: string) => void;
  onNext: (engine: string) => void;
  onSkip: () => void;
}) {
  const health = useHealth();
  const report = useSetupReport(health.isSuccess);
  const qc = useQueryClient();
  const install = useInstallEngine();
  const job = useLiveJob(jobId);
  const r = report.data;
  const [pick, setPick] = useState<string | null>((job?.payload?.engine as string | undefined) ?? null);

  useEffect(() => {
    if (r && !pick) setPick(r.recommended.engine);
  }, [r, pick]);
  useEffect(() => {
    if (job?.status === "done") for (const k of ["setup-report", "engines", "options"]) void qc.invalidateQueries({ queryKey: [k] });
  }, [job?.status, qc]);

  const options: EnginePick[] = r ? [r.recommended, ...r.alternatives] : [];
  const chosen = options.find((o) => o.engine === pick) ?? r?.recommended;
  const jobFor = job?.payload?.engine as string | undefined;
  const installing = jobActive(job) && jobFor === chosen?.engine;
  const installed = !!chosen && (chosen.ready || (job?.status === "done" && jobFor === chosen.engine));

  if (!health.isSuccess || (!r && !report.isError)) {
    return (
      <>
        <StepHeader eyebrow="Your engine" title="Getting to know this computer" />
        <div className="flex items-center justify-center gap-3 rounded-2xl border border-line bg-surface px-5 py-5 text-[14px] text-muted">
          <Loader2 className="size-5 animate-spin text-fire" /> Checking your graphics card…
        </div>
      </>
    );
  }
  if (!r) {
    return (
      <>
        <StepHeader eyebrow="Your engine" title="Couldn't check this computer">
          That's fine: try again, or choose an engine later on the Engines page.
        </StepHeader>
        <StepActions>
          <Button variant="primary" leading={<RotateCw className="size-4" />} loading={report.isFetching} onClick={() => void report.refetch()}>
            Try again
          </Button>
          <Button variant="ghost" trailing={<ArrowRight className="size-4" />} onClick={onSkip}>
            Choose later
          </Button>
        </StepActions>
      </>
    );
  }

  return (
    <>
      <StepHeader eyebrow="Your engine" title="Pick the engine that makes your voices">
        Each engine has its own strengths. This one suits your computer best; you can add others any time.
      </StepHeader>

      <div className="mb-4 flex items-center justify-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
        <Cpu className="size-5 shrink-0 text-fire" />
        <div className="min-w-0 text-[13px]">
          <span className="font-medium text-ink">{r.gpu?.name ?? "No NVIDIA graphics card found"}</span>
          <span className="text-muted">
            {r.vram_gb ? ` · ${r.vram_gb.toFixed(0)} GB of graphics memory` : " · FireVoice will use the processor"} · {r.voices} voices ready
          </span>
        </div>
      </div>

      <div role="radiogroup" aria-label="Engine" className="space-y-2.5">
        {options.map((o, i) => {
          const on = pick === o.engine;
          return (
            <button
              key={o.engine}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={jobActive(job)}
              onClick={() => setPick(o.engine)}
              className={cn(
                "flex w-full items-start gap-3.5 rounded-2xl border px-4 py-3.5 text-left transition-colors disabled:opacity-70",
                on ? "border-fire/60 bg-fire-soft/60" : "border-line bg-surface hover:border-line-strong",
              )}
            >
              <span className={cn("mt-1 flex size-[18px] shrink-0 items-center justify-center rounded-full border-2", on ? "border-fire" : "border-line-strong")}>
                {on && <span className="size-2 rounded-full bg-fire" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold text-ink">{o.title}</span>
                  {i === 0 && <Badge tone="fire"><Sparkles className="size-3" /> Best for you</Badge>}
                  {o.tier?.quality && o.tier.quality !== "-" && <Badge>{o.tier.quality}</Badge>}
                  {o.tier?.speed && o.tier.speed !== "-" && <Badge><Zap className="size-3" /> {o.tier.speed}</Badge>}
                  {o.ready || (job?.status === "done" && jobFor === o.engine) ? (
                    <Badge tone="ok">Ready</Badge>
                  ) : (
                    !o.installable && <Badge tone="warn">Not available here</Badge>
                  )}
                </span>
                <span className="mt-1 block text-[13px] leading-relaxed text-muted">{o.reason}</span>
              </span>
            </button>
          );
        })}
      </div>

      {installing && job && (
        <div className="mt-4">
          <InstallProgress job={job} title={chosen?.title ?? "the engine"} />
        </div>
      )}
      {job?.status === "failed" && jobFor === chosen?.engine && (
        <p className="mt-3 text-center text-[13px] text-bad">
          {typeof job.error === "string" ? job.error : job.error?.message || "The install did not finish."}
        </p>
      )}
      {!installed && !installing && chosen?.installable && (
        <p className="mt-4 flex items-start justify-center gap-2 text-center text-[12.5px] leading-relaxed text-muted">
          <Download className="mt-0.5 size-3.5 shrink-0 text-fire" />
          A few GB. You can carry on with the next steps while it downloads.
        </p>
      )}

      <StepActions>
        {installed ? (
          <Button variant="primary" size="lg" trailing={<ArrowRight className="size-4" />} onClick={() => onNext(chosen!.engine)}>
            Continue with {chosen!.title}
          </Button>
        ) : installing ? (
          <Button variant="primary" size="lg" trailing={<ArrowRight className="size-4" />} onClick={() => onNext(chosen!.engine)}>
            Continue while it installs
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            leading={<Download className="size-4" />}
            disabled={!chosen?.installable}
            loading={install.isPending}
            onClick={() => chosen && install.mutate({ name: chosen.engine }, { onSuccess: (j) => onJob(j.id) })}
          >
            Install {chosen?.title ?? ""}
          </Button>
        )}
        <Button variant="ghost" size="lg" onClick={onSkip}>
          Choose later
        </Button>
      </StepActions>
    </>
  );
}

/* ----------------------------------------------------------------------------------------- 4. first words ---- */

function FirstWords({ engine, jobId, onNext, onBack }: { engine: string | null; jobId: string | null; onNext: () => void; onBack: () => void }) {
  const voices = useVoices();
  const featured = (voices.data ?? []).filter((v) => v.featured).slice(0, 5);
  const [voice, setVoice] = useState<string>("default");
  const [text, setText] = useState(HELLO);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audio, setAudio] = useState<{ url: string; blob: Blob } | null>(null);
  const job = useLiveJob(jobId);
  // the engine picked a moment ago may still be installing: then this step waits for it (or the user moves on)
  const waiting = jobActive(job) && job?.payload?.engine === engine;

  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url); }, [audio]);

  const say = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.tts({ text: text.trim() || HELLO, engine: engine ?? undefined, voice, style: "conversational" });
      setAudio({ url: URL.createObjectURL(r.blob), blob: r.blob });
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <StepHeader eyebrow="First words" title="Hear FireVoice speak">
        Pick a voice, change the line if you like, and press play. The first line takes a little longer while the engine wakes up.
      </StepHeader>

      {featured.length > 0 && (
        <div role="radiogroup" aria-label="Voice" className="mb-4 flex flex-wrap justify-center gap-2">
          {[{ voice_id: "default", name: "Default", avatar: null as number | null, tagline: "" }, ...featured].map((v) => {
            const on = voice === v.voice_id;
            const img = api.voiceAvatarUrl(v);
            return (
              <button
                key={v.voice_id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setVoice(v.voice_id)}
                className={cn(
                  "flex items-center gap-2 rounded-full border py-1 pr-3.5 pl-1 text-[13px] font-medium transition-colors",
                  on ? "border-fire/60 bg-fire-soft text-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong",
                )}
              >
                {img ? (
                  <img src={img} alt="" className="size-7 rounded-full object-cover" />
                ) : (
                  <span className="flex size-7 items-center justify-center rounded-full fire-gradient text-white">
                    <Sparkles className="size-3.5" />
                  </span>
                )}
                {v.name}
              </button>
            );
          })}
        </div>
      )}

      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="text-[15px] leading-relaxed" aria-label="What FireVoice says" />

      <div className="mt-4">
        {waiting && job ? (
          <InstallProgress job={job} title="your engine" />
        ) : audio ? (
          <AudioPlayer src={audio.url} autoPlay label="Your first line" />
        ) : (
          <div className="flex h-[54px] items-center justify-center rounded-xl border border-dashed border-line bg-surface-2/50">
            {busy ? (
              <span className="flex items-center gap-2 text-[13px] text-muted">
                <Waveform bars={12} className="h-6" /> Making your first line…
              </span>
            ) : (
              <span className="text-[13px] text-faint">Your line plays here</span>
            )}
          </div>
        )}
        {waiting && <p className="mt-2 text-center text-[12.5px] text-muted">You can try it once the engine is installed, or carry on and come back to it later.</p>}
        {error && (
          <p className="mt-3 text-center text-[13px] text-bad">
            {error} {!engine && "You can install an engine on the Engines page."}
          </p>
        )}
      </div>

      <StepActions onBack={onBack}>
        <Button
          variant={audio ? "outline" : "primary"}
          size="lg"
          leading={audio ? <RotateCw className="size-4" /> : <Play className="size-4 fill-current" />}
          loading={busy}
          disabled={waiting}
          onClick={() => void say()}
        >
          {audio ? "Say it again" : "Say it"}
        </Button>
        <Button variant={audio ? "primary" : "ghost"} size="lg" trailing={<ArrowRight className="size-4" />} onClick={onNext}>
          {audio ? "Next" : "Skip"}
        </Button>
      </StepActions>
    </>
  );
}

/* -------------------------------------------------------------------------------------------- 5. dictation ---- */

function Keys({ hotkey }: { hotkey: string }) {
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {hotkeyLabels(hotkey).map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

function DictationStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const config = useDictation((s) => s.config);
  const set = useDictation((s) => s.set);
  const live = useDictationLive();
  const online = useHealth().isSuccess;
  const info = useBackend((s) => s.info);
  const extras = useBackend((s) => s.extras);
  const desktop = inTauri();
  // speech recognition comes with the background part of the setup: until that is in, dictation cannot listen yet
  const libsPending = desktop && info?.mode === "bundled" && !info.full_ready;
  const active = live.phase === "starting" || live.phase === "listening" || live.phase === "finishing";
  const [mics, setMics] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (desktop) dictation.mics().then(setMics).catch(() => setMics([]));
  }, [desktop]);

  // what was just dictated lands in the try-it box
  useEffect(() => {
    if (live.phase === "listening" || live.phase === "finishing") document.getElementById("onb-dictation-try")?.focus();
  }, [live.phase]);

  const row = "flex items-center justify-between gap-6 py-3.5";
  return (
    <>
      <StepHeader eyebrow="Dictation" title="Type with your voice, in any program">
        Press a hotkey in a browser, a chat or a document, speak, and FireVoice types what you say. It all happens on this computer.
      </StepHeader>

      <div className="rounded-2xl border border-line bg-surface px-5">
        <div className={cn(row, "border-b border-line")}>
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-fire-soft text-fire">
              <Keyboard className="size-[18px]" />
            </span>
            <div>
              <span className="block text-[14px] font-medium text-ink">Dictation</span>
              <span className="block text-[12.5px] text-muted">
                {config.enabled ? (
                  <>
                    {config.activation === "hold" ? "Hold" : "Press"} <Keys hotkey={config.hotkey} /> anywhere to start
                  </>
                ) : (
                  "Off: turn it on to use the hotkey"
                )}
              </span>
            </div>
          </div>
          <Switch checked={config.enabled} onChange={(v) => set({ enabled: v })} label={config.enabled ? "On" : "Turn on"} disabled={!desktop} />
        </div>
        <div className={cn("transition-opacity", !config.enabled && "pointer-events-none opacity-50")}>
          <div className={cn(row, "border-b border-line")}>
            <span className="text-[13.5px] font-medium text-ink">Hotkey</span>
            <HotkeyRecorder value={config.hotkey} onChange={(hotkey) => set({ hotkey })} disabled={!desktop} />
          </div>
          <div className={cn(row, "border-b border-line")}>
            <span className="text-[13.5px] font-medium text-ink">Start and stop</span>
            <Segmented<DictationConfig["activation"]>
              ariaLabel="Start and stop"
              size="sm"
              value={config.activation}
              onChange={(v) => set({ activation: v })}
              options={[
                { value: "toggle", label: "Press to start, again to stop" },
                { value: "hold", label: "Hold while speaking" },
              ]}
            />
          </div>
          <div className={row}>
            <span className="text-[13.5px] font-medium text-ink">Microphone</span>
            <Select
              ariaLabel="Microphone"
              size="sm"
              className="w-60"
              value={config.mic}
              onChange={(v) => set({ mic: v })}
              options={[{ value: "", label: "System default" }, ...mics.map((m) => ({ value: m, label: m }))]}
            />
          </div>
        </div>
      </div>

      {!desktop && (
        <p className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          <AlertTriangle className="size-4 shrink-0" /> Dictation works in the FireVoice desktop app, not in a browser.
        </p>
      )}

      {desktop && config.enabled && (
        <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
              <Mic className="size-4 text-fire" /> Try it
              {active && <Badge tone="info" dot>{live.phase === "listening" ? "Listening" : "Working"}</Badge>}
            </span>
            <Button
              variant={active ? "outline" : "primary"}
              size="sm"
              disabled={!online || libsPending || live.phase === "finishing"}
              leading={active ? <Square className="size-3.5" /> : <Mic className="size-3.5" />}
              onClick={() => {
                document.getElementById("onb-dictation-try")?.focus();
                dictation.toggle().catch(() => setDraft((d) => d));
              }}
            >
              {active ? "Stop" : "Start dictating"}
            </Button>
          </div>
          {libsPending ? (
            <div className="rounded-xl bg-surface-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-muted">
              <span className="flex items-center gap-2 font-medium text-ink">
                <Loader2 className="size-3.5 animate-spin text-fire" /> Speech recognition is still downloading
                {extras?.status === "running" && ` · ${Math.round(extras.progress * 100)}%`}
              </span>
              Your settings are saved. The hotkey works as soon as the download finishes, even after you've moved on.
            </div>
          ) : (
            <>
              <textarea
                id="onb-dictation-try"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                placeholder={`Click here and press ${hotkeyLabels(config.hotkey).join("+")} (or Start dictating), then say something.`}
                className={cn(
                  "w-full resize-none rounded-xl border bg-surface-2 px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none transition-[border-color,box-shadow]",
                  "placeholder:text-faint focus:border-fire focus:shadow-[0_0_0_3px_var(--fire-soft)]",
                  live.phase === "listening" ? "border-fire" : "border-line-strong",
                )}
              />
              {live.phase === "error" && live.message && <p className="mt-2 text-[12.5px] text-bad">{live.message}</p>}
              {live.hotkeyError && <p className="mt-2 text-[12.5px] text-warn">{live.hotkeyError}</p>}
            </>
          )}
        </div>
      )}

      <StepActions onBack={onBack}>
        <Button variant="primary" size="lg" trailing={<ArrowRight className="size-4" />} onClick={onNext}>
          {config.enabled ? "Next" : "Skip dictation"}
        </Button>
      </StepActions>
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ 6. ready ---- */

function ReadyStep({
  engine,
  jobId,
  onFinish,
  onBack,
}: {
  engine: string | null;
  jobId: string | null;
  onFinish: (tour: boolean) => void;
  onBack: () => void;
}) {
  const [tour, setTour] = useState(true);
  const job = useLiveJob(jobId);
  const config = useDictation((s) => s.config);
  const extras = useBackend((s) => s.extras);
  const report = useSetupReport(useHealth().isSuccess);
  const engineTitle = [report.data?.recommended, ...(report.data?.alternatives ?? [])].find((o) => o?.engine === engine)?.title ?? engine;
  const rows = [
    {
      label: "Voice engine",
      value: !engine ? "Choose one later on the Engines page" : jobActive(job) ? `${engineTitle} · installing, ${Math.round((job?.progress ?? 0) * 100)}%` : `${engineTitle} · ready`,
      ok: !!engine && !jobActive(job),
    },
    {
      label: "Dictation",
      value: config.enabled ? (
        <>
          On · <Keys hotkey={config.hotkey} />
        </>
      ) : (
        "Off · turn it on any time on the Dictation page"
      ),
      ok: config.enabled,
    },
    {
      label: "Graphics card support",
      value: extras?.status === "running" ? `Downloading in the background · ${Math.round(extras.progress * 100)}%` : "Installed",
      ok: extras?.status !== "running",
    },
  ];
  return (
    <>
      <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-full bg-ok text-white shadow-[0_0_0_8px_color-mix(in_oklab,var(--ok)_18%,transparent)]">
        <Check className="size-8" strokeWidth={3} />
      </div>
      <StepHeader eyebrow="Ready" title="FireVoice is ready for you">
        Here's where things stand. Anything still installing carries on in the background, and the corner of the window shows how far it is.
      </StepHeader>
      <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-3 px-4 py-3.5">
            <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", r.ok ? "bg-ok text-white" : "bg-fire-soft text-fire")}>
              {r.ok ? <Check className="size-3.5" strokeWidth={3} /> : <Loader2 className="size-3.5 animate-spin" />}
            </span>
            <span className="w-44 shrink-0 text-[13.5px] font-medium text-ink">{r.label}</span>
            <span className="min-w-0 flex-1 text-[13px] text-muted">{r.value}</span>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex justify-center">
        <Switch
          checked={tour}
          onChange={setTour}
          label={
            <span className="flex items-center gap-2">
              <Compass className="size-4 text-fire" /> Show me around the app (one minute)
            </span>
          }
        />
      </div>
      <StepActions onBack={onBack}>
        <Button variant="primary" size="lg" className="h-12 px-8 text-[15px]" leading={<Sparkles className="size-4" />} onClick={() => onFinish(tour)}>
          Start using FireVoice
        </Button>
      </StepActions>
    </>
  );
}
