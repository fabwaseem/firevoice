import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { useHealth } from "@/lib/api/hooks";
import { inTauri } from "@/lib/backend";
import { useBackend } from "@/stores/backend";
import { useDictation } from "@/stores/dictation";
import { useSettings } from "@/stores/settings";

/**
 * The writing assistant sets itself up in the background: once the first-run setup and the onboarding are done, the
 * app downloads it on start when this computer suits it (enough memory and disk; a graphics card is not needed). Never
 * when it was removed on purpose, and never twice at once (an install that is already running is left alone; one that
 * was interrupted picks up where it stopped).
 */
export function useAutoAssistant() {
  const qc = useQueryClient();
  const onboarded = useSettings((s) => s.onboarded);
  const declined = useDictation((s) => s.config.assistantDeclined);
  const online = useHealth().isSuccess;
  const info = useBackend((s) => s.info);
  // the runtime's own big download (GPU support and the libraries) comes first
  const runtimeReady = !inTauri() || (info != null && (info.full_ready || info.mode !== "bundled"));
  const tried = useRef(false);

  useEffect(() => {
    if (tried.current || !onboarded || declined || !online || !runtimeReady) return;
    tried.current = true;
    void (async () => {
      try {
        const s = await api.dictationAssistant();
        if (s.installed || !s.suits) return;
        const running = await api.jobs({ kind: "writer", limit: 3 });
        if (running.jobs.some((j) => j.status === "queued" || j.status === "running")) return;
        await api.installAssistant();
        void qc.invalidateQueries({ queryKey: ["jobs"] });
      } catch {
        /* not this time: the next start tries again */
      }
    })();
  }, [onboarded, declined, online, runtimeReady, qc]);
}
