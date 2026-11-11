/** Delivery styles are a Firebrand feature. Firebrand (IndexTTS-2) controls emotion apart from who is speaking, so a
 * style is clearly heard and the voice stays the same; Firestorm takes the same emotion settings. On other engines a
 * style could only nudge the speed and pauses, so the app does not offer styles there. */
import { Palette } from "lucide-react";
import { useEngines, useOptions } from "@/lib/api/hooks";
import type { Engine } from "@/lib/api/types";
import { useStudio } from "@/stores/studio";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

/** The engine that acts styles out, suggested when another one is chosen. */
export const STYLE_ENGINE = "indextts2";

/** The style sent when the engine does not act styles: the voice's own natural delivery. */
export const PLAIN_STYLE = "conversational";

export function actsStyles(engine?: Pick<Engine, "params"> | null): boolean {
  return !!engine?.params?.some((p) => p.name === "emo_vector");
}

/** Whether the engine with this name (or the server's default engine) acts styles out. */
export function useActsStyles(engineName?: string | null): { acts: boolean; engine?: Engine; loading: boolean } {
  const engines = useEngines();
  const options = useOptions();
  const name = engineName ?? options.data?.default_engine;
  const list = engines.data ?? options.data?.engines ?? [];
  const engine = list.find((e) => e.name === name);
  return { acts: actsStyles(engine), engine, loading: !list.length && (engines.isLoading || options.isLoading) };
}

/** In place of a style picker, on an engine that does not act styles: says so, and offers Firebrand in Speak. */
export function StylesNeedFirebrand({ engineTitle, offerSwitch = true, className }: { engineTitle?: string; offerSwitch?: boolean; className?: string }) {
  const engines = useEngines();
  const firebrand = (engines.data ?? []).find((e) => e.name === STYLE_ENGINE);
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border border-dashed border-line bg-surface-2/50 px-3.5 py-2.5", className)}>
      <Palette className="size-4 shrink-0 text-faint" />
      <p className="min-w-0 flex-1 leading-snug">
        <span className="block text-[13px] font-medium text-ink-2">Styles need {firebrand?.title ?? "Firebrand"}</span>
        <span className="block text-[12px] text-muted">{engineTitle ?? "This engine"} uses the voice's own delivery</span>
      </p>
      {offerSwitch && firebrand && (
        <Button size="sm" variant="outline" onClick={() => useStudio.getState().set({ engine: STYLE_ENGINE })}>
          Use {firebrand.title}
        </Button>
      )}
    </div>
  );
}
