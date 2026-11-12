import { Languages } from "@/components/icons";
import { Select, Switch } from "@/components/ui";
import { SPEECH_LANGUAGES, speechLanguageName } from "@/lib/speechLanguages";
import { useDictation } from "@/stores/dictation";
import { useAssistant } from "./DictationAssistant";

/** Speak in any language, and it is written in the one you choose. */
export function DictationTranslate() {
  const config = useDictation((s) => s.config);
  const set = useDictation((s) => s.set);
  const assistant = useAssistant();
  const on = config.translateTo !== "";
  const target = config.translateTo || "en";
  const ready = !!assistant.data?.installed;
  const limited = on && !ready;

  return (
    <div className="space-y-3 rounded-[12px] bg-surface-2 px-3.5 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <Languages className="mt-0.5 size-4 shrink-0 text-fire" />
          <div className="min-w-0">
            <span className="block text-[13px] font-medium text-ink">Translate what I say</span>
            <span className="block text-[12px] text-muted">
              {on
                ? `Speak in any language: it is written in ${speechLanguageName(target)}, punctuated, when you stop.`
                : "Speak in one language and have it written in another, for example speak Urdu and write English."}
            </span>
          </div>
        </div>
        <Switch checked={on} onChange={(v) => set({ translateTo: v ? target : "" })} />
      </div>
      {on && (
        <div className="flex items-center justify-between gap-4 pl-6.5">
          <span className="text-[12.5px] text-ink-2">Write it in</span>
          <Select
            ariaLabel="Write it in"
            size="sm"
            className="w-48"
            value={target}
            onChange={(v) => set({ translateTo: v })}
            options={SPEECH_LANGUAGES.map((l) => ({ value: l.code, label: l.name }))}
          />
        </div>
      )}
      {limited && (
        <p className="pl-6.5 text-[12px] text-warn">
          Translating needs the writing assistant (Writing assistant tab). Until it is installed, your words go in as you said them.
        </p>
      )}
    </div>
  );
}
