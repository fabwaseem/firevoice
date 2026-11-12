import { Rocket, X } from "@/components/icons";
import { useHealth, useSetupReport } from "@/lib/api/hooks";
import { useResumeSetup } from "@/stores/firstrun";
import { Button } from "@/components/ui";
import { useManagesEngine } from "./useBackendLifecycle";

/** For someone who left the first setup early (an older version let them skip it): a plain prompt, shown until FireVoice
 * has a voice engine and its voice library. It opens the setup again; nothing else in the app is blocked meanwhile. */
export function FinishSetupBanner() {
  const managed = useManagesEngine();
  const online = useHealth().isSuccess;
  const dismissed = useResumeSetup((s) => s.dismissed);
  const report = useSetupReport(managed && online);
  const r = report.data;
  if (!managed || !online || dismissed || !r) return null;

  const noEngine = r.ready_engines.length === 0;
  const noVoices = r.library.available && !r.library.installed;
  if (!noEngine && !noVoices) return null;
  const what = noEngine && noVoices ? "a voice engine and the voice library" : noEngine ? "a voice engine" : "the voice library";

  return (
    <div role="status" className="mx-auto mb-4 flex max-w-[1400px] items-center gap-3 rounded-xl bg-fire-soft px-4 py-3 text-[13px] text-ink">
      <Rocket className="size-4 shrink-0 text-fire" />
      <span className="flex-1">
        <span className="font-medium">Finish setting up FireVoice.</span> It still needs {what} before it can make speech. FireVoice picks what suits your
        computer and downloads it.
      </span>
      <Button size="sm" variant="primary" onClick={() => useResumeSetup.getState().set({ resume: true })}>
        Finish setup
      </Button>
      <button
        type="button"
        onClick={() => useResumeSetup.getState().set({ dismissed: true })}
        className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink"
        aria-label="Not now"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
