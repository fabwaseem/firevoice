import { useState } from "react";
import { ArrowRight, BookA, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { errMessage } from "@/lib/api/hooks";
import type { DictationVocabulary } from "@/lib/api/types";
import { Button, Card, CardBody, CardHeader, EmptyState, Input, Tooltip } from "@/components/ui";

export const VOCAB_KEY = ["dictation-vocabulary"];

export function useVocabulary() {
  return useQuery({ queryKey: VOCAB_KEY, queryFn: api.dictationVocabulary, staleTime: 10_000 });
}

/** Names and terms to spell your way, and what the speech model writes wrongly with what you want instead. */
export function DictationVocabularyPanel() {
  return (
    <div className="flex flex-col gap-4">
      <WordsCard />
      <ReplacementsCard />
    </div>
  );
}

function WordsCard() {
  const qc = useQueryClient();
  const vocab = useVocabulary();
  const [draft, setDraft] = useState("");
  const words = vocab.data?.words ?? [];
  const save = useMutation({
    mutationFn: (next: string[]) => api.setDictationWords(next),
    onSuccess: (r) => qc.setQueryData<DictationVocabulary>(VOCAB_KEY, (v) => (v ? { ...v, words: r.words } : v)),
    onError: (e) => toast.error(errMessage(e)),
  });
  const add = () => {
    const parts = draft
      .split(/[,\n]/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (!parts.length) return;
    save.mutate([...words, ...parts]);
    setDraft("");
  };
  return (
    <Card>
      <CardHeader
        title="Your words"
        description="Names, brands and terms FireVoice should expect and spell exactly like this, whatever the case it hears them in."
      />
      <CardBody className="space-y-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add words, e.g. FireVoice, Kubernetes, Anjum" aria-label="Add words" />
          <Button type="submit" variant="soft" leading={<Plus className="size-4" />} disabled={!draft.trim()} loading={save.isPending}>
            Add
          </Button>
        </form>
        {words.length === 0 ? (
          <p className="text-[12.5px] text-faint">No words yet. Separate several with commas.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {words.map((w) => (
              <span key={w} className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 pr-1 pl-3 text-[13px] text-ink">
                {w}
                <button
                  type="button"
                  aria-label={`Remove ${w}`}
                  onClick={() => save.mutate(words.filter((x) => x !== w))}
                  className="grid size-5 place-items-center rounded-full text-faint hover:bg-surface-3 hover:text-ink"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function ReplacementsCard() {
  const qc = useQueryClient();
  const vocab = useVocabulary();
  const [heard, setHeard] = useState("");
  const [write, setWrite] = useState("");
  const rows = vocab.data?.replacements ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: VOCAB_KEY });
  const save = useMutation({
    mutationFn: api.saveReplacement,
    onSuccess: () => {
      setHeard("");
      setWrite("");
      void refresh();
    },
    onError: (e) => toast.error(errMessage(e)),
  });
  const del = useMutation({ mutationFn: api.deleteReplacement, onSuccess: () => void refresh(), onError: (e) => toast.error(errMessage(e)) });
  return (
    <Card>
      <CardHeader title="Replacements" description="When FireVoice writes the left side, it puts the right side instead. Handy for names it keeps getting wrong." />
      <CardBody className="space-y-4">
        <form
          className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (heard.trim() && write.trim()) save.mutate({ heard, write });
          }}
        >
          <Input value={heard} onChange={(e) => setHeard(e.target.value)} placeholder="It writes… (e.g. fire voice)" aria-label="What it writes" />
          <ArrowRight className="size-4 text-faint" />
          <Input value={write} onChange={(e) => setWrite(e.target.value)} placeholder="You want… (e.g. FireVoice)" aria-label="What you want" />
          <Button type="submit" variant="soft" leading={<Plus className="size-4" />} disabled={!heard.trim() || !write.trim()} loading={save.isPending}>
            Add
          </Button>
        </form>
        {rows.length === 0 ? (
          <EmptyState icon={<BookA />} title="No replacements yet" description="Add one above, or from a dictation in your history." />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="group flex items-center gap-3 py-2.5 text-[13.5px]">
                <span className="min-w-0 flex-1 truncate text-muted">{r.heard}</span>
                <ArrowRight className="size-3.5 shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{r.write}</span>
                <Tooltip content="Remove">
                  <button
                    type="button"
                    aria-label={`Remove ${r.heard}`}
                    onClick={() => del.mutate(r.id)}
                    className="grid size-8 place-items-center rounded-[9px] text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-bad-soft hover:text-bad focus:opacity-100"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
