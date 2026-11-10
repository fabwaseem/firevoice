import { AlertTriangle, Download, RotateCw } from "lucide-react";
import { useHealth } from "@/lib/api/hooks";
import { apiCompat } from "@/lib/backend";
import { useBackend } from "@/stores/backend";
import { Button } from "@/components/ui";
import { useManagesEngine } from "./useBackendLifecycle";

/** A banner when the engine and the app disagree on versions. Starting, setting up and updating the engine happen in
 * useBackendLifecycle, and their screens in StartupGate. */
export function BackendManager() {
  const health = useHealth();
  const { phase, info } = useBackend();
  const active = useManagesEngine();
  const compat = health.data ? apiCompat(health.data.api_version, health.data.min_client_api) : "ok";
  if (compat === "ok") return null;

  return (
    <div role="alert" className="mx-auto mb-4 flex max-w-[1400px] items-center gap-3 rounded-xl bg-warn-soft px-4 py-3 text-[13px] text-warn">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="flex-1">
        {compat === "server-too-old"
          ? info?.running
            ? "FireVoice's voice engine is older than the app. Restart it to get the new features."
            : "FireVoice's voice engine is older than this app needs, so some pages will not work. Restart FireVoice to update it."
          : "FireVoice's voice engine needs a newer app. Update FireVoice."}
      </span>
      {active && compat === "server-too-old" && info?.running && info.mode !== "bundled" && (
        <Button
          size="sm"
          variant="soft"
          loading={phase === "starting"}
          onClick={async () => {
            await useBackend.getState().stop();
            await useBackend.getState().start();
          }}
          leading={<RotateCw className="size-3.5" />}
        >
          Restart
        </Button>
      )}
      {active && info?.mode === "bundled" && compat === "server-too-old" && (
        <Button size="sm" variant="soft" onClick={() => useBackend.getState().runSetup()} leading={<Download className="size-3.5" />}>
          Update now
        </Button>
      )}
    </div>
  );
}
