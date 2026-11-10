import { useEffect, useRef } from "react";
import { useHealth } from "@/lib/api/hooks";
import { inTauri, localPort } from "@/lib/backend";
import { useBackend } from "@/stores/backend";
import { useSettings } from "@/stores/settings";

/** Whether this app runs (and so looks after) the voice engine: desktop only, with the engine on this computer. */
export function useManagesEngine() {
  const manage = useSettings((s) => s.manageBackend);
  const serverUrl = useSettings((s) => s.serverUrl);
  return inTauri() && manage && localPort(serverUrl) != null;
}

/** Starts the engine the app manages, sets it up or updates it when needed, and notices when it stops. Mounted once,
 * above everything (StartupGate), so the screens that show this progress never sit on top of the app. */
export function useBackendLifecycle() {
  const active = useManagesEngine();
  const health = useHealth();
  const { phase, info } = useBackend();
  const tried = useRef(false);

  // Once per launch: if nothing answers, start (or set up, or update) the engine.
  useEffect(() => {
    if (!active || tried.current || health.isLoading || health.isSuccess) return;
    tried.current = true;
    void (async () => {
      const st = useBackend.getState();
      const i = await st.refresh();
      if (!i) return;
      if (i.mode === "none") {
        st.set({ phase: "failed", error: "FireVoice could not find its voice engine on this computer. Reinstall FireVoice." });
        return;
      }
      if (i.running) return;
      // an app update ships a newer engine: bring the runtime in step before starting it (only FireVoice itself is
      // reinstalled; torch and the rest stay), so the engine always matches the app
      const stale = i.mode === "bundled" && !!i.installed_version && (!i.ready || (!!i.bundled_version && i.installed_version !== i.bundled_version));
      if (stale) return st.runSetup();
      if (i.ready) return st.start();
      // first run: the quick part of the setup starts right away, while the welcome screen is still up
      if (i.mode === "bundled") return st.runSetup();
    })();
  }, [active, health.isLoading, health.isSuccess]);

  // Once the engine answers, install the rest (torch and the voice libraries) in the background, or resume a download
  // an earlier run left half way. The app stays usable; BackgroundSetup shows the progress.
  const extrasStarted = useRef(false);
  useEffect(() => {
    if (!active || !health.isSuccess || !info || extrasStarted.current) return;
    if (info.mode !== "bundled" || !info.ready || info.full_ready) return;
    extrasStarted.current = true;
    void useBackend.getState().finishSetup();
  }, [active, health.isSuccess, info]);

  // Know whether the engine that answers is one this app started.
  useEffect(() => {
    if (active && health.isSuccess && !info) void useBackend.getState().refresh();
  }, [active, health.isSuccess, info]);

  // An older engine already answering (started before the app updated): stop it and update it, once.
  const autoUpdated = useRef(false);
  useEffect(() => {
    if (!active || !health.isSuccess || !info || info.mode !== "bundled" || autoUpdated.current) return;
    if (info.installed_version && info.bundled_version && info.installed_version !== info.bundled_version && phase === "idle") {
      autoUpdated.current = true;
      void (async () => {
        await useBackend.getState().stop();
        await useBackend.getState().runSetup();
      })();
    }
  }, [active, health.isSuccess, info, phase]);

  // Watch the process the app started: one that exits (crashes) is reported within seconds.
  const watching = active && (phase === "starting" || (phase === "idle" && !!info?.running));
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(() => void useBackend.getState().refresh(), phase === "starting" ? 2000 : 5000);
    return () => clearInterval(t);
  }, [watching, phase]);

  // "starting" lasts until the engine answers; one that never does is reported with its log.
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
}
