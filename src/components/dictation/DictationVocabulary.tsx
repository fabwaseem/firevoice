import { ArrowRight, BookA } from "lucide-react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

export const VOCAB_KEY = ["dictation-vocabulary"];

/** What dictation knows: the words it expects (your dictionary), what it fixes when misheard, and your snippets. */
export function useVocabulary() {
  return useQuery({ queryKey: VOCAB_KEY, queryFn: api.dictationVocabulary, staleTime: 10_000 });
}

/** Your names and terms live in the Dictionary, shared with the voices and transcription: this leads there. */
export function DictionaryLinkCard() {
  const vocab = useVocabulary();
  const words = vocab.data?.words ?? [];
  const fixes = vocab.data?.replacements.length ?? 0;
  return (
    <Link
      to="/dictionary"
      className="group flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5 transition-colors hover:border-fire/40 hover:bg-surface-2"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-fire-soft text-fire">
        <BookA className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium text-ink">Your names and terms</span>
        <span className="block truncate text-[12.5px] text-muted">
          {words.length
            ? `${words.length} word${words.length === 1 ? "" : "s"}${fixes ? `, ${fixes} misheard form${fixes === 1 ? "" : "s"} fixed` : ""}: ${words.slice(0, 5).join(", ")}${words.length > 5 ? "…" : ""}`
            : "Add the names FireVoice should spell your way. The voices use the same dictionary."}
        </span>
      </span>
      <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-fire">
        Dictionary <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
