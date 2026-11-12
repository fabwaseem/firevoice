import { Plus, X } from "@/components/icons";
import { useQuery } from "@tanstack/react-query";
import { Select } from "@/components/ui";
import { api } from "@/lib/api/client";
import { systemLanguages } from "@/lib/dictation";
import { SPEECH_LANGUAGES, speechLanguageName } from "@/lib/speechLanguages";
import { useDictation } from "@/stores/dictation";

/** Which language dictation listens for: one chosen language, or automatic among the ones you speak. */
export function DictationLanguages() {
  const config = useDictation((s) => s.config);
  const set = useDictation((s) => s.set);
  const mine = config.languages;
  const auto = config.language === "auto";
  const recent = useQuery({ queryKey: ["dictation-history", "", 200], queryFn: () => api.dictationHistory("", 200), enabled: auto, staleTime: 30_000 });
  // what to suggest: the languages FireVoice was sure of in your dictations, then the ones this computer is set up for
  const known = new Set(SPEECH_LANGUAGES.map((l) => l.code));
  const seen: string[] = [];
  for (const h of recent.data?.items ?? []) {
    if (h.language && (h.language_chosen || (h.language_p ?? 0) >= 0.8) && !seen.includes(h.language)) seen.push(h.language);
  }
  const suggestions = [...seen, ...systemLanguages()].filter((c, i, a) => known.has(c) && a.indexOf(c) === i && !mine.includes(c)).slice(0, 5);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <span className="block text-[13px] font-medium text-ink">Language</span>
          <span className="block text-[12px] text-muted">
            {auto
              ? mine.length > 1
                ? "Automatic: FireVoice tells which of your languages you are speaking, and checks again when you stop."
                : mine.length === 1
                  ? `Always ${speechLanguageName(mine[0])}.`
                  : "Automatic: any language. Add the ones you speak below and it never guesses another."
              : "Always this language: the fastest and most accurate when you dictate in one language."}
          </span>
        </div>
        <Select
          ariaLabel="Language"
          size="sm"
          className="w-48"
          value={config.language}
          onChange={(v) => set({ language: v })}
          options={[{ value: "auto", label: "Automatic" }, ...SPEECH_LANGUAGES.map((l) => ({ value: l.code, label: l.name }))]}
        />
      </div>

      {auto && (
        <div className="rounded-[12px] bg-surface-2 px-3.5 py-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[12.5px] font-medium text-ink-2">Languages you speak</span>
            <Select
              ariaLabel="Add a language"
              size="sm"
              className="w-48"
              value=""
              onChange={(v) => v && !mine.includes(v) && set({ languages: [...mine, v] })}
              options={[
                { value: "", label: "Add a language…" },
                ...SPEECH_LANGUAGES.filter((l) => !mine.includes(l.code)).map((l) => ({ value: l.code, label: l.name })),
              ]}
            />
          </div>
          {mine.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {mine.map((c) => (
                <span key={c} className="inline-flex h-7 items-center gap-1 rounded-full bg-surface pr-1 pl-3 text-[13px] text-ink">
                  {speechLanguageName(c)}
                  <button
                    type="button"
                    aria-label={`Remove ${speechLanguageName(c)}`}
                    onClick={() => set({ languages: mine.filter((x) => x !== c) })}
                    className="grid size-5 place-items-center rounded-full text-faint hover:bg-surface-3 hover:text-ink"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-1.5 text-[12px] text-faint">None yet: every language the speech model knows is possible, which makes a wrong guess likelier.</p>
          )}
          {suggestions.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-faint">Suggested:</span>
              {suggestions.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set({ languages: [...mine, c] })}
                  className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 text-[12.5px] text-ink-2 hover:border-fire hover:text-fire"
                >
                  <Plus className="size-3" /> {speechLanguageName(c)}
                </button>
              ))}
            </div>
          )}
          {mine.includes("ur") && mine.includes("hi") && (
            <p className="mt-2 text-[12px] text-warn">
              Spoken Urdu and Hindi sound almost the same, so FireVoice can mix them up. Keep only the one you write in (Urdu or Hindi script).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
