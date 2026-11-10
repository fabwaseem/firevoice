import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, FileText, Loader2, Rocket, RotateCw, Server } from "lucide-react";
import { useHealth } from "@/lib/api/hooks";
import { apiCompat, backend, inTauri, localPort } from "@/lib/backend";
import { useBackend } from "@/stores/backend";
import { useSettings } from "@/stores/settings";
import { Button, Dialog, ProgressBar } from "@/components/ui";
import { Logo } from "./Logo";

/** Starts the backend the app manages (desktop only) and shows the one-time setup when its runtime is missing or
 * older than this app. Nothing here runs in a browser or when the server URL points at another machine. */
export function BackendManager() {
  const manage = useSettings((s) => s.manageBackend);
  const serverUrl = useSettings((s) => s.serverUrl);
  const health = useHealth();
  const { phase, setup, error, info } = useBackend();
  const tried = useRef(false);
  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState("");
  const local = localPort(serverUrl) != null;
  const active = inTauri() && manage && local;

  // Once per launch: if nothing answers at the server URL, start (or set up) the managed backend.
  useEffect(() => {
    if (!active || tried.current || health.isLoading || health.isSuccess) return;
    tried.current = true;
    void (async () => {
      const st = useBackend.getState();
      const i = await st.refresh();
      if (!i || i.mode === "none" || i.running) return;
      if (i.ready) return st.start();
      if (i.mode === "bundled") st.set({ phase: i.installed_version ? "needs-update" : "needs-setup" });
    })();
  }, [active, health.isLoading, health.isSuccess]);

  // Know whether the server that answers is one this app started (so it can offer to restart or update it).
  useEffect(() => {
    if (active && health.isSuccess && !info) void useBackend.getState().refresh();
  }, [active, health.isSuccess, info]);

  // An app update ships a newer backend: offer to update the runtime even while the old one answers.
  useEffect(() => {
    if (!active || !health.isSuccess || !info || info.mode !== "bundled") return;
    if (info.installed_version && info.bundled_version && info.installed_version !== info.bundled_version && phase === "idle") {
      useBackend.getState().set({ phase: "needs-update" });
    }
  }, [active, health.isSuccess, info, phase]);

  // Watch the process the app started: one that exits (crashes) is reported within seconds, not at the timeout below.
  const watching = active && (phase === "starting" || (phase === "idle" && !!info?.running));
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(() => void useBackend.getState().refresh(), phase === "starting" ? 2000 : 5000);
    return () => clearInterval(t);
  }, [watching, phase]);

  // "starting" lasts until the server answers; a backend that never does is reported with its log.
  useEffect(() => {
    if (phase !== "starting") return;
    if (health.isSuccess) {
      useBackend.getState().set({ phase: "idle" });
      return;
    }
    const t = setTimeout(() => {
      if (useBackend.getState().phase === "starting")
        useBackend.getState().set({ phase: "failed", error: "FireVoice's voice engine started but did not answer within 3 minutes. The log usually says why." });
    }, 180_000);
    return () => clearTimeout(t);
  }, [phase, health.isSuccess]);

  const compat = health.data ? apiCompat(health.data.api_version, health.data.min_client_api) : "ok";
  const blocking = active && (phase === "needs-setup" || phase === "setting-up" || (phase === "failed" && !health.isSuccess) || phase === "starting");
  const updating = phase === "needs-update" || (phase === "setting-up" && !!info?.installed_version);

  const showLog = async () => {
    setLog(await backend.logs(300).catch((e) => String(e)));
    setLogOpen(true);
  };

  return (
    <>
      {compat !== "ok" && (
        <div role="alert" className="mx-auto mb-4 flex max-w-[1400px] items-center gap-3 rounded-xl bg-warn-soft px-4 py-3 text-[13px] text-warn">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="flex-1">
            {compat === "server-too-old"
              ? info?.running
                ? "FireVoice's voice engine is older than the app. Restart it to get the new features (Dubbing, Sound and more)."
                : `The FireVoice server at ${serverUrl} is older than this app needs, so some pages will not work. Restart or update it.`
              : `The FireVoice server at ${serverUrl} needs a newer app. Update FireVoice.`}
          </span>
          {active && compat === "server-too-old" && info?.running && info.mode !== "bundled" && (
            <Button size="sm" variant="soft" loading={phase === "starting"} onClick={async () => {
              await useBackend.getState().stop();
              await useBackend.getState().start();
            }} leading={<RotateCw className="size-3.5" />}>
              Restart
            </Button>
          )}
          {active && info?.mode === "bundled" && compat === "server-too-old" && (
            <Button size="sm" variant="soft" onClick={() => useBackend.getState().runSetup()} leading={<Download className="size-3.5" />}>
              Update now
            </Button>
          )}
        </div>
      )}

      {active && phase === "needs-update" && health.isSuccess && (
        <div className="mx-auto mb-4 flex max-w-[1400px] items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 text-[13px] text-ink-2">
          <Server className="size-4 shrink-0 text-fire" />
          <span className="flex-1">
            A newer voice engine came with this update ({info?.bundled_version}; you have {info?.installed_version}). Updating takes a minute and keeps your voices and projects.
          </span>
          <Button size="sm" onClick={() => useBackend.getState().runSetup()} leading={<Download className="size-3.5" />}>
            Update now
          </Button>
          <Button size="sm" variant="ghost" onClick={() => useBackend.getState().set({ phase: "idle" })}>
            Later
          </Button>
        </div>
      )}

      {blocking && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-bg/95 backdrop-blur-sm">
          <div className="w-[min(520px,92vw)] text-center">
            <Logo size={44} className="mx-auto mb-6" />
            {phase === "starting" && (
              <>
                <Loader2 className="mx-auto size-6 animate-spin text-fire" />
                <p className="mt-3 text-[14px] text-ink-2">Starting the FireVoice engine…</p>
              </>
            )}
            {phase === "needs-setup" && (
              <>
                <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Set up FireVoice on this computer</h1>
                <p className="mt-2 text-[14px] leading-relaxed text-muted">
                  FireVoice runs entirely on your computer. The first start downloads what it needs to make voices, including GPU support
                  (about 4 GB, only once). Your voices and projects stay on this computer.
                </p>
                <div className="mt-6 flex justify-center gap-2">
                  <Button onClick={() => useBackend.getState().runSetup()} leading={<Rocket className="size-4" />}>Set up now</Button>
                  <Button variant="ghost" onClick={() => useSettings.getState().set({ manageBackend: false })} leading={<Server className="size-4" />}>
                    I run my own server
                  </Button>
                </div>
              </>
            )}
            {phase === "setting-up" && setup && (
              <>
                <h1 className="text-[20px] font-semibold text-ink">{updating ? "Updating FireVoice" : "Setting up FireVoice"}</h1>
                <p className="mt-1 text-[13px] text-faint">
                  Step {Math.min(setup.step + 1, setup.steps)} of {setup.steps}
                </p>
                <ProgressBar value={(setup.step + 0.5) / setup.steps} className="mt-4" />
                <p className="mt-3 truncate text-[12.5px] text-muted" title={setup.message}>
                  {setup.message}
                </p>
              </>
            )}
            {phase === "failed" && (
              <>
                <h1 className="text-[20px] font-semibold text-ink">FireVoice could not start</h1>
                <p className="mt-2 break-words text-[13px] text-bad">{error}</p>
                <div className="mt-5 flex justify-center gap-2">
                  <Button onClick={() => (info?.ready ? useBackend.getState().start() : useBackend.getState().runSetup())} leading={<RotateCw className="size-4" />}>Try again</Button>
                  <Button variant="ghost" leading={<FileText className="size-4" />} onClick={showLog}>
                    Show log
                  </Button>
                  <Button variant="ghost" onClick={() => useBackend.getState().set({ phase: "idle" })}>
                    Close
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <Dialog open={logOpen} onOpenChange={setLogOpen} title="Engine log" description="Technical details that help explain what went wrong." size="xl">
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">{log || "(empty)"}</pre>
      </Dialog>
    </>
  );
}
