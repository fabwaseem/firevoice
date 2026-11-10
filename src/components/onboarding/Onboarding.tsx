import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowRight, Check, Cpu, Download, FileText, HardDrive, Loader2, Lock, Play, Rocket, RotateCw, Sparkles, Zap,
} from "lucide-react";
import { api } from "@/lib/api/client";
import { errMessage, useHealth, useInstallEngine, useJob, useSetupReport, useVoices } from "@/lib/api/hooks";
import type { EnginePick } from "@/lib/api/types";
import { backend, inTauri } from "@/lib/backend";
import { useBackend } from "@/stores/backend";
import { useSettings } from "@/stores/settings";
import { useStudio } from "@/stores/studio";
import { AudioPlayer, Badge, Button, Dialog, ProgressBar, Textarea } from "@/components/ui";
import { Logo } from "@/components/shell/Logo";
import { cn } from "@/lib/utils";
import { FEATURES, SplitLayout, StepHeader, Waveform, type StepInfo } from "./OnboardingLayout";

const HELLO = "Hello! This is FireVoice, speaking from your own computer. Everything you write stays right here.";

/* ------------------------------------------------------------------------------------------------------------------
 * The whole first run: welcome, set up the engine (only when this computer needs it), choose an engine, first words.
 * It replaces the app until it is done, so nothing flickers behind it.
 * ---------------------------------------------------------------------------------------------------------------- */
export function Onboarding() {
  const info = useBackend((s) => s.info);
  const phase = useBackend((s) => s.phase);
  const [step, setStep] = useState<"welcome" | "setup" | "engine" | "voice">("welcome");
  // the setup step is listed only on computers that need it (it stays listed once it was needed)
  const needed = inTauri() && (phase === "needs-setup" || phase === "setting-up" || (!!info && info.mode === "bundled" && !info.ready));
  const neededOnce = useRef(false);
  if (needed) neededOnce.current = true;
  const steps: StepInfo[] = [
    { id: "welcome", title: "Welcome", hint: "What FireVoice can do" },
    ...(neededOnce.current ? [{ id: "setup", title: "Set up", hint: "One-time, on this computer" }] : []),
    { id: "engine", title: "Your engine", hint: "The voice maker that fits" },
    { id: "voice", title: "First words", hint: "Hear it speak" },
  ];
  const [engine, setEngine] = useState<string | null>(null);

  const finish = () => {
    if (engine) useStudio.getState().set({ engine });
    useSettings.getState().set({ onboarded: true });
  };

  // the engine stopped or needs (re)installing part way through: show that, then carry on where the user was
  const blocked = inTauri() && (phase === "failed" || phase === "needs-setup" || phase === "setting-up");
  if (blocked) neededOnce.current = true;

  if (step === "welcome") return <WelcomeHero onStart={() => setStep(neededOnce.current ? "setup" : "engine")} />;
  if (blocked && step !== "setup") {
    return (
      <SplitLayout steps={steps} current="setup" spotlightLabel="While FireVoice gets ready">
        <SetupPanel />
      </SplitLayout>
    );
  }
  return (
    <SplitLayout steps={steps} current={step} spotlightLabel={step === "setup" ? "While FireVoice gets ready" : "Inside FireVoice"}>
      {step === "setup" && <SetupPanel onReady={() => setStep("engine")} />}
      {step === "engine" && <EngineStep onPicked={(e) => { setEngine(e); setStep("voice"); }} onSkip={() => setStep("voice")} />}
      {step === "voice" && <FirstWords engine={engine} onDone={finish} onBack={() => setStep("engine")} />}
    </SplitLayout>
  );
}

/* ---------------------------------------------------------------------------------------------- 1. welcome ---- */

function WelcomeHero({ onStart }: { onStart: () => void }) {
  return (
    <div className="onb-hero flex h-full w-full items-center justify-center overflow-y-auto px-8 py-12">
      <div className="w-full max-w-[980px] text-center">
        <div className="onb-rise mx-auto mb-7 w-fit rounded-[26px] onb-glow">
          <Logo size={84} />
        </div>
        <h1 className="onb-rise text-[46px] leading-[1.05] font-semibold tracking-[-0.035em] text-ink" style={{ animationDelay: "80ms" }}>
          Natural voices,
          <br />
          <span className="bg-gradient-to-r from-fire-2 to-fire bg-clip-text text-transparent">made on your own computer.</span>
        </h1>
        <p className="onb-rise mx-auto mt-5 max-w-[620px] text-[16px] leading-relaxed text-muted" style={{ animationDelay: "160ms" }}>
          FireVoice turns text into expressive speech, copies and designs voices, dubs, transcribes and makes sound, all on your
          graphics card. Private, fast, and yours.
        </p>

        <div className="mt-11 grid grid-cols-2 gap-3 text-left md:grid-cols-4">
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

        <div className="onb-rise mt-11 flex flex-col items-center gap-3" style={{ animationDelay: "720ms" }}>
          <Button size="lg" variant="primary" className="h-12 px-8 text-[15px]" trailing={<ArrowRight className="size-4" />} onClick={onStart}>
            Get started
          </Button>
          <p className="flex items-center gap-1.5 text-[12.5px] text-faint">
            <Lock className="size-3.5" /> Takes a few minutes. Nothing you make ever leaves this computer.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ 2. set up ---- */

const SETUP_STEPS = [
  { title: "Runtime", text: "A private space for FireVoice to run in" },
  { title: "Graphics card support", text: "What lets your GPU make voices (the biggest part)" },
  { title: "Voice engine", text: "FireVoice itself" },
  { title: "Final check", text: "Making sure everything works together" },
];

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
        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="primary" size="lg" leading={<RotateCw className="size-4" />} onClick={() => void retry()}>
            Try again
          </Button>
          <Button variant="ghost" size="lg" leading={<FileText className="size-4" />} onClick={() => void showLog()}>
            Show the log
          </Button>
        </div>
        <LogDialog log={log} onClose={() => setLog(null)} />
      </>
    );
  }

  if (phase === "setting-up" || phase === "starting" || ready) {
    const total = setup?.steps ?? 4;
    const at = ready ? total : phase === "starting" ? total : Math.min(setup?.step ?? 0, total - 1);
    const frac = ready ? 1 : phase === "starting" ? 0.97 : Math.min(0.95, ((setup?.step ?? 0) + 0.5) / total);
    return (
      <>
        <StepHeader
          eyebrow={updating ? "Update" : "Set up"}
          title={ready ? "All set" : phase === "starting" ? "Starting the voice engine" : updating ? "Updating the voice engine" : "Setting up FireVoice"}
        >
          {ready
            ? "FireVoice is ready on this computer."
            : phase === "starting"
              ? "The first start takes up to a minute."
              : "This happens once. You can leave it running; it finishes by itself."}
        </StepHeader>
        <div className="rounded-2xl border border-line bg-surface p-5">
          <div className="mb-2 flex items-baseline justify-between text-[13px]">
            <span className="font-medium text-ink">{ready ? "Done" : `${Math.round(frac * 100)}%`}</span>
            {!ready && <span className="text-faint tabular">{mmss(elapsed)}</span>}
          </div>
          <ProgressBar value={frac} />
          <ul className="mt-5 space-y-3">
            {SETUP_STEPS.slice(0, total).map((s, n) => {
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
          <Button className="mt-6" variant="primary" size="lg" trailing={<ArrowRight className="size-4" />} onClick={onReady}>
            Continue
          </Button>
        )}
      </>
    );
  }

  // needs setup: what it is, then one button
  return (
    <>
      <StepHeader eyebrow={updating ? "Update" : "Set up"} title={updating ? "Update the voice engine" : "Set up FireVoice on this computer"}>
        FireVoice runs entirely on your computer, so it needs a few parts the first time. They install once; after that it starts in
        seconds.
      </StepHeader>
      <div className="space-y-2.5">
        {[
          { icon: HardDrive, title: "Up to 4 GB, once", text: "Less if those parts are already on this computer." },
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
      <Button className="mt-7" variant="primary" size="lg" leading={<Rocket className="size-4" />} onClick={() => void useBackend.getState().runSetup()}>
        Set up now
      </Button>
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

function EngineStep({ onPicked, onSkip }: { onPicked: (engine: string | null) => void; onSkip: () => void }) {
  const health = useHealth();
  const report = useSetupReport(health.isSuccess);
  const qc = useQueryClient();
  const install = useInstallEngine();
  const [pick, setPick] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId).data;
  const r = report.data;

  useEffect(() => {
    if (r && !pick) setPick(r.recommended.engine);
  }, [r, pick]);
  useEffect(() => {
    if (job?.status === "done") for (const k of ["setup-report", "engines", "options"]) void qc.invalidateQueries({ queryKey: [k] });
  }, [job?.status, qc]);

  const options: EnginePick[] = r ? [r.recommended, ...r.alternatives] : [];
  const chosen = options.find((o) => o.engine === pick) ?? r?.recommended;
  const installing = !!job && (job.status === "queued" || job.status === "running");
  const installed = !!chosen && (chosen.ready || (job?.status === "done" && jobId != null));

  if (!health.isSuccess || (!r && !report.isError)) {
    return (
      <>
        <StepHeader eyebrow="Your engine" title="Getting to know this computer" />
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-5 py-5 text-[14px] text-muted">
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
        <div className="flex gap-2">
          <Button variant="primary" leading={<RotateCw className="size-4" />} loading={report.isFetching} onClick={() => void report.refetch()}>Try again</Button>
          <Button variant="ghost" trailing={<ArrowRight className="size-4" />} onClick={onSkip}>Choose later</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <StepHeader eyebrow="Your engine" title="Pick the engine that makes your voices">
        Each engine has its own strengths. This one suits your computer best; you can add others any time.
      </StepHeader>

      <div className="mb-4 flex items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3">
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
              disabled={installing}
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
                  {o.ready ? <Badge tone="ok">Ready</Badge> : !o.installable && <Badge tone="warn">Not available here</Badge>}
                </span>
                <span className="mt-1 block text-[13px] leading-relaxed text-muted">{o.reason}</span>
              </span>
            </button>
          );
        })}
      </div>

      {installing && job && (
        <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
          <div className="mb-2 flex items-baseline justify-between text-[13px]">
            <span className="font-medium text-ink">Installing {chosen?.title}</span>
            <span className="text-faint tabular">{Math.round((job.progress ?? 0) * 100)}%</span>
          </div>
          <ProgressBar value={job.progress ?? 0} />
          <p className="mt-2 truncate text-[12.5px] text-muted">{job.message || "Starting…"}</p>
        </div>
      )}
      {job?.status === "failed" && (
        <p className="mt-3 text-[13px] text-bad">{typeof job.error === "string" ? job.error : job.error?.message || "The install did not finish."}</p>
      )}

      <div className="mt-7 flex flex-wrap items-center gap-2">
        {installed ? (
          <Button variant="primary" size="lg" trailing={<ArrowRight className="size-4" />} onClick={() => onPicked(chosen!.engine)}>
            Continue with {chosen!.title}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            leading={<Download className="size-4" />}
            disabled={!chosen?.installable || installing}
            loading={install.isPending || installing}
            onClick={() => chosen && install.mutate({ name: chosen.engine }, { onSuccess: (j) => setJobId(j.id) })}
          >
            {installing ? "Installing…" : `Install ${chosen?.title ?? ""}`}
          </Button>
        )}
        <Button variant="ghost" size="lg" onClick={onSkip}>
          Choose later
        </Button>
      </div>
    </>
  );
}

/* ----------------------------------------------------------------------------------------- 4. first words ---- */

function FirstWords({ engine, onDone, onBack }: { engine: string | null; onDone: () => void; onBack: () => void }) {
  const voices = useVoices();
  const featured = (voices.data ?? []).filter((v) => v.featured).slice(0, 5);
  const [voice, setVoice] = useState<string>("default");
  const [text, setText] = useState(HELLO);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audio, setAudio] = useState<{ url: string; blob: Blob } | null>(null);

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
        <div role="radiogroup" aria-label="Voice" className="mb-4 flex flex-wrap gap-2">
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
        {audio ? (
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
        {error && (
          <p className="mt-3 text-[13px] text-bad">
            {error} {!engine && "You can install an engine on the Engines page."}
          </p>
        )}
      </div>

      <div className="mt-7 flex flex-wrap items-center gap-2">
        {audio ? (
          <Button variant="primary" size="lg" leading={<Sparkles className="size-4" />} onClick={onDone}>
            Start creating
          </Button>
        ) : (
          <Button variant="primary" size="lg" leading={<Play className="size-4 fill-current" />} loading={busy} onClick={() => void say()}>
            Say it
          </Button>
        )}
        {audio && (
          <Button variant="ghost" size="lg" leading={<RotateCw className="size-4" />} loading={busy} onClick={() => void say()}>
            Say it again
          </Button>
        )}
        {!audio && (
          <Button variant="ghost" size="lg" onClick={onDone}>
            Skip
          </Button>
        )}
        <button type="button" onClick={onBack} className="ml-auto text-[13px] font-medium text-muted hover:text-ink">
          Back
        </button>
      </div>
    </>
  );
}
