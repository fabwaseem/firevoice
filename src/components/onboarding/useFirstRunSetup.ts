import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { errMessage, useHealth, useSetupReport } from "@/lib/api/hooks";
import type { EnginePick, Hardware, VoiceLibraryStatus } from "@/lib/api/types";
import { fmtBytes, inTauri } from "@/lib/backend";
import { useBackend } from "@/stores/backend";
import { useStudio } from "@/stores/studio";
import { jobError, useLiveJob } from "./useLiveJob";

/* Everything a new computer needs before FireVoice can make its first voice, run in order and reported honestly:
 *
 *   env     Python and FireVoice's own engine (quick; the desktop shell does it, see src-tauri/src/backend.rs)
 *   gpu     PyTorch, the graphics support (the big download, with real progress)
 *   libs    the voice libraries that sit on it
 *   voices  the ready-made voice library (a server job, in parallel with the two above)
 *   model   the engine that suits THIS computer (hardware.py picks it), installed with its weights
 *   load    that engine loaded into the graphics card, so the first render starts at once
 *
 * Every step is safe to repeat: whatever is already there counts as done, so a setup that was closed half way carries on. */

export type PhaseId = "env" | "gpu" | "libs" | "voices" | "model" | "load";
export type PhaseState = "waiting" | "active" | "done" | "failed";

export interface Phase {
  id: PhaseId;
  label: string;
  detail: string;
  state: PhaseState;
  /** 0..1 within this step */
  frac: number;
  error?: string;
}

export interface FirstRunSetup {
  phases: Phase[];
  /** 0..1 over everything */
  progress: number;
  etaSeconds: number | null;
  done: boolean;
  failed: Phase | null;
  engine: EnginePick | null;
  hardware: Hardware | null;
  library: VoiceLibraryStatus | null;
  retry: () => void;
}

const WEIGHT: Record<PhaseId, number> = { env: 0.1, gpu: 0.38, libs: 0.12, voices: 0.05, model: 0.25, load: 0.1 };

export function useFirstRunSetup(enabled: boolean): FirstRunSetup {
  const qc = useQueryClient();
  const health = useHealth();
  const backendPhase = useBackend((s) => s.phase);
  const setup = useBackend((s) => s.setup);
  const info = useBackend((s) => s.info);
  const extras = useBackend((s) => s.extras);
  const backendError = useBackend((s) => s.error);
  const tauri = inTauri();

  const coreReady = health.isSuccess && backendPhase === "idle";
  const report = useSetupReport(enabled && coreReady);
  const hardware = report.data?.hardware ?? null;
  const library = report.data?.library ?? null;

  // ---- the engine for this computer: picked once, kept for the whole run (disk space shrinks as things download)
  const [engine, setEngine] = useState<EnginePick | null>(null);
  useEffect(() => {
    if (enabled && !engine && report.data?.recommended) setEngine(report.data.recommended);
  }, [enabled, engine, report.data]);

  // ---- voices (a server job; starts as soon as the engine of the app answers, alongside the downloads)
  const [voicesJobId, setVoicesJobId] = useState<string | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const voicesStarted = useRef(false);
  const voicesJob = useLiveJob(voicesJobId);
  const voicesDone = !!library && (library.installed || !library.available || voicesJob?.status === "done");
  useEffect(() => {
    if (!enabled || !coreReady || !library || voicesStarted.current || library.installed || !library.available) return;
    voicesStarted.current = true;
    api.installVoiceLibrary().then((j) => setVoicesJobId(j.id)).catch((e) => setVoicesError(errMessage(e)));
  }, [enabled, coreReady, library]);
  useEffect(() => {
    if (voicesJob?.status === "done") void qc.invalidateQueries({ queryKey: ["setup-report"] });
  }, [voicesJob?.status, qc]);

  // ---- graphics support and libraries (the desktop shell downloads them; "done" once nothing is missing)
  // (until the shell has reported what kind of runtime this is, nothing counts as done)
  const runtimeDone = !tauri || extras?.status === "done" || (info != null && (info.full_ready || info.mode !== "bundled"));
  const runtimeFailed = tauri && extras?.status === "failed";
  const extrasProgress = extras?.status === "done" || runtimeDone ? 1 : (extras?.progress ?? 0);
  const gpuFrac = Math.min(1, extrasProgress / 0.8);
  const libsFrac = Math.min(1, Math.max(0, (extrasProgress - 0.8) / 0.2));

  // ---- the model (a server job), once the runtime is complete (an engine needs the libraries in place)
  const [modelJobId, setModelJobId] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelAlready, setModelAlready] = useState(false);
  const modelStarted = useRef(false);
  const modelJob = useLiveJob(modelJobId);
  const modelDone = modelAlready || modelJob?.status === "done";
  useEffect(() => {
    if (!enabled || !coreReady || !runtimeDone || !engine || modelStarted.current) return;
    modelStarted.current = true;
    (async () => {
      try {
        const plan = await api.installPlan(engine.engine, false);
        if (plan.installed) return setModelAlready(true);
        const j = await api.installEngine(engine.engine);
        setModelJobId(j.id);
      } catch (e) {
        setModelError(errMessage(e));
      }
    })();
  }, [enabled, coreReady, runtimeDone, engine]);
  useEffect(() => {
    if (modelJob?.status === "done") for (const k of ["setup-report", "engines", "options"]) void qc.invalidateQueries({ queryKey: [k] });
  }, [modelJob?.status, qc]);

  // ---- loading it into the graphics card, so the first render does not wait for it
  const [loadState, setLoadState] = useState<"idle" | "loading" | "done">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadStarted = useRef(false);
  useEffect(() => {
    if (!enabled || !modelDone || !engine || loadStarted.current) return;
    loadStarted.current = true;
    setLoadState("loading");
    api
      .loadEngine(engine.engine)
      // every render is checked by a speech model that downloads on first use (1.6 GB): fetch it now, not in the
      // middle of the first render. A failure here is not fatal: the render then checks itself the first time.
      .then(() => api.warmSpeech().catch(() => undefined))
      .then(() => {
        useStudio.getState().set({ engine: engine.engine });
        setLoadState("done");
      })
      .catch((e) => {
        setLoadError(errMessage(e));
        setLoadState("idle");
      });
  }, [enabled, modelDone, engine]);

  // ---- the phases, as the screen shows them
  const fail = (msg: string | null | undefined) => (msg ? msg : undefined);
  const vErr = fail(voicesError ?? jobError(voicesJob));
  const mErr = fail(modelError ?? jobError(modelJob));
  const exFail = runtimeFailed ? (extras?.error ?? "The download did not finish.") : undefined;
  const exLibs = exFail && (extras?.stage === "install" || extras?.stage === "check");

  const torch = extras?.items.find((i) => i.id === "wheel:torch");
  const dl = extras && extras.stage === "download" && extras.total_bytes > 0
    ? `${fmtBytes(extras.done_bytes)} of ${fmtBytes(extras.total_bytes)}${extras.bytes_per_sec > 0 ? ` · ${fmtBytes(extras.bytes_per_sec)}/s` : ""}`
    : "";

  const phases: Phase[] = [
    {
      id: "env",
      label: "Setting up the environment",
      detail: backendPhase === "failed" ? "" : (setup?.message?.replace(/^[A-Za-z ]+: /, "") ?? "Python and FireVoice's own engine"),
      state: backendPhase === "failed" ? "failed" : coreReady || (!tauri && health.isSuccess) ? "done" : "active",
      frac: coreReady ? 1 : backendPhase === "starting" ? 0.97 : Math.min(0.95, ((setup?.step ?? 0) + 0.5) / (setup?.steps ?? 3)),
      error: backendPhase === "failed" ? (backendError ?? "The setup did not finish.") : undefined,
    },
    {
      id: "gpu",
      label: "GPU support (PyTorch)",
      detail: runtimeDone ? "Installed" : dl || (torch?.state === "active" ? "Downloading…" : "Starts as soon as the environment is ready"),
      state: runtimeDone ? "done" : exFail && !exLibs ? "failed" : coreReady ? "active" : "waiting",
      frac: gpuFrac,
      error: exFail && !exLibs ? exFail : undefined,
    },
    {
      id: "libs",
      label: "Voice libraries",
      detail: runtimeDone ? "Installed" : (extras?.stage === "install" || extras?.stage === "check") && extras.message ? extras.message : "Speech and audio tools",
      state: runtimeDone ? "done" : exLibs ? "failed" : gpuFrac >= 1 && coreReady ? "active" : "waiting",
      frac: libsFrac,
      error: exLibs ? exFail : undefined,
    },
    {
      id: "voices",
      label: library?.count ? `The voice library (${library.count} voices)` : "The voice library",
      detail: voicesDone ? "Added" : voicesJob?.message ?? (coreReady ? "Starting…" : "Starts as soon as the environment is ready"),
      state: vErr ? "failed" : voicesDone ? "done" : coreReady ? "active" : "waiting",
      frac: voicesDone ? 1 : (voicesJob?.progress ?? 0),
      error: vErr,
    },
    {
      id: "model",
      label: engine ? `Your voice engine: ${engine.title}` : "Your voice engine",
      detail: modelDone ? "Installed" : modelJob?.message ?? engine?.reason ?? (coreReady ? "Checking your computer…" : "Waits for the steps above"),
      state: mErr ? "failed" : modelDone ? "done" : runtimeDone && coreReady && engine ? "active" : "waiting",
      frac: modelDone ? 1 : (modelJob?.progress ?? 0),
      error: mErr,
    },
    {
      id: "load",
      label: "Getting it ready",
      detail: loadState === "done" ? "Ready to speak" : loadState === "loading" ? `Loading ${engine?.title ?? "the engine"} into your graphics card and getting the speech checker ready. The first time takes a few minutes.` : "Loads your engine so the first render starts at once",
      state: loadError ? "failed" : loadState === "done" ? "done" : loadState === "loading" ? "active" : "waiting",
      frac: loadState === "done" ? 1 : loadState === "loading" ? 0.5 : 0,
      error: loadError ?? undefined,
    },
  ];

  const progress = phases.reduce((s, p) => s + WEIGHT[p.id] * (p.state === "done" ? 1 : p.frac), 0);
  const done = phases.every((p) => p.state === "done");
  const failed = phases.find((p) => p.state === "failed") ?? null;

  // ---- time left: from how far along it is and how long it has taken (shown once there is enough to go on)
  const t0 = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  if (enabled && t0.current == null) t0.current = Date.now();
  useEffect(() => {
    if (!enabled || done) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [enabled, done]);
  const elapsed = t0.current ? (now - t0.current) / 1000 : 0;
  const etaSeconds = !done && !failed && progress > 0.05 && elapsed > 12 ? (elapsed * (1 - progress)) / progress : null;

  const retry = useCallback(() => {
    const id = failed?.id;
    if (id === "env") {
      const s = useBackend.getState();
      void (s.info?.ready ? s.start() : s.runSetup());
    } else if (id === "gpu" || id === "libs") {
      void useBackend.getState().finishSetup();
    } else if (id === "voices") {
      voicesStarted.current = false;
      setVoicesError(null);
      setVoicesJobId(null);
      void qc.invalidateQueries({ queryKey: ["setup-report"] });
    } else if (id === "model") {
      modelStarted.current = false;
      setModelError(null);
      setModelJobId(null);
      setEngine(null); // pick again: the disk may have more room now
      void qc.invalidateQueries({ queryKey: ["setup-report"] });
    } else if (id === "load") {
      loadStarted.current = false;
      setLoadError(null);
      setLoadState("idle");
    }
  }, [failed?.id, qc]);

  return { phases, progress: Math.min(1, progress), etaSeconds, done, failed, engine, hardware, library, retry };
}
