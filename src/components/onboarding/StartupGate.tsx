import { useRef, type ReactNode } from "react";
import { useHealth } from "@/lib/api/hooks";
import { useBackend } from "@/stores/backend";
import { useSettings } from "@/stores/settings";
import { useBackendLifecycle, useManagesEngine } from "@/components/shell/useBackendLifecycle";
import { useDictationBridge } from "@/components/dictation/useDictationBridge";
import { Logo } from "@/components/shell/Logo";
import { Onboarding, SetupPanel } from "./Onboarding";
import { OnboardingFrame, Waveform } from "./OnboardingLayout";

/** Decides what the window shows before the app: the first-run flow, the engine starting / updating / failing, or the
 * app itself. These are whole screens, never layers over the app, so nothing behind them redraws or flickers. */
export function StartupGate({ children }: { children: ReactNode }) {
  useBackendLifecycle();
  // dictation works from the first run on (onboarding has a step to set it up and try it), not only inside the app
  useDictationBridge();
  const onboarded = useSettings((s) => s.onboarded);
  const managed = useManagesEngine();
  const health = useHealth();
  const phase = useBackend((s) => s.phase);
  const info = useBackend((s) => s.info);

  // once the app is open, a slow or missed health check must never swap it out (work in progress would be lost);
  // only a real engine problem does
  const booted = useRef(false);
  if (health.isSuccess && onboarded) booted.current = true;

  if (!onboarded) return <Onboarding />;
  if (!managed || health.isSuccess) return <>{children}</>;
  if (booted.current) {
    const problem = phase === "needs-setup" || phase === "setting-up" || phase === "failed";
    if (!problem) return <>{children}</>;
  } else if (phase === "idle" || phase === "starting") {
    // a returning user whose engine is waking up
    return <Starting />;
  }
  const updating = !!info?.installed_version;
  return (
    <OnboardingFrame current="engine">
      <SetupPanel updating={updating} />
    </OnboardingFrame>
  );
}

/** Every start: the engine wakes up (a few seconds), shown as calmly as the splash before it. */
function Starting() {
  return (
    <div className="onb-hero flex h-full w-full flex-col items-center justify-center gap-6">
      <div className="rounded-[22px] onb-glow">
        <Logo size={64} />
      </div>
      <Waveform bars={18} className="h-8 opacity-90" />
      <p className="text-[13.5px] text-muted">Starting FireVoice…</p>
    </div>
  );
}
