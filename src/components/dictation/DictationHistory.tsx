import { useEffect, useState } from "react";
import { ArrowRight, Clock, Copy, GraduationCap, Languages, Mic, Search, Trash2, Type, Wand2, Zap } from "lucide-react";
import { toast } from "sonner";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { errMessage } from "@/lib/api/hooks";
import type { DictationHistoryItem } from "@/lib/api/types";
import { langName, relTime } from "@/lib/utils";
import { Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, Dialog, EmptyState, Input, Tooltip } from "@/components/ui";
import { VOCAB_KEY } from "./DictationVocabulary";

export const HISTORY_KEY = ["dictation-history"];
const PAGE = 40;

/** Every dictation, searchable, kept by FireVoice on this computer. */
export function DictationHistoryPanel() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [confirm, setConfirm] = useState(false);
  const [teach, setTeach] = useState<{ heard: string; write: string } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const hist = useQuery({ queryKey: [...HISTORY_KEY, query, limit], queryFn: () => api.dictationHistory(query, limit), placeholderData: keepPreviousData });
  const refresh = () => qc.invalidateQueries({ queryKey: HISTORY_KEY });
  const del = useMutation({ mutationFn: api.deleteDictation, onSuccess: () => void refresh(), onError: (e) => toast.error(errMessage(e)) });
  const clear = useMutation({
    mutationFn: api.clearDictationHistory,
    onSuccess: () => {
      setConfirm(false);
      void refresh();
    },
    onError: (e) => toast.error(errMessage(e)),
  });
  const learn = useMutation({
    mutationFn: api.saveReplacement,
    onSuccess: (r) => {
      setTeach(null);
      toast.success(`From now on “${r.heard}” is written “${r.write}”.`);
      void qc.invalidateQueries({ queryKey: VOCAB_KEY });
    },
    onError: (e) => toast.error(errMessage(e)),
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  };
  const fixWord = (h: DictationHistoryItem) => {
    const sel = window.getSelection()?.toString().trim() ?? "";
    setTeach({ heard: sel && h.text.includes(sel) ? sel : "", write: "" });
  };

  const d = hist.data;
  const wpm = d && d.seconds > 5 ? Math.round(d.words / (d.seconds / 60)) : null;
  const saved = d ? Math.max(0, d.words / 40 - d.seconds / 60) : 0; // the same words typed at 40 a minute

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { icon: Type, label: query ? "Words in these" : "Words dictated", value: d ? d.words.toLocaleString() : "–" },
          { icon: Zap, label: "Speaking speed", value: wpm ? `${wpm} wpm` : "–" },
          { icon: Clock, label: "Time saved over typing", value: saved >= 1 ? `${Math.round(saved)} min` : "–" },
        ].map(({ icon: Icon, label, value }) => (
          <Card key={label} className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-fire-soft text-fire">
              <Icon className="size-[17px]" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold text-ink tabular">{value}</div>
              <div className="truncate text-[12px] text-muted">{label}</div>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="History"
          description="Everything you dictated, kept on this computer. Select a word in a dictation to teach FireVoice how to write it."
          action={
            (d?.total ?? 0) > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>
                Clear all
              </Button>
            )
          }
        />
        <CardBody className="space-y-3">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your dictations" aria-label="Search your dictations" leading={<Search className="size-4" />} />
          {d && d.items.length === 0 ? (
            <EmptyState
              icon={<Mic />}
              title={query ? "Nothing matches" : "Nothing dictated yet"}
              description={query ? "Try other words." : "What you dictate shows up here, ready to copy again."}
            />
          ) : (
            <ul className="divide-y divide-line">
              {d?.items.map((h) => (
                <li key={h.id} className="group flex items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink select-text">{h.text}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-faint">
                      {h.translated_to && (
                        <Badge tone="info" className="!h-[18px]">
                          <Languages className="size-3" /> {langName(h.language)} → {langName(h.translated_to)}
                        </Badge>
                      )}
                      {h.mode === "command" && (
                        <Badge tone="fire" className="!h-[18px]">
                          <Wand2 className="size-3" /> Command
                        </Badge>
                      )}
                      <span>{relTime(h.at)}</span>
                      <span>· {h.words} words</span>
                      {h.app && <span>· {h.app.charAt(0).toUpperCase() + h.app.slice(1)}</span>}
                      {h.language && <span>· {langName(h.language)}</span>}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <Tooltip content="Teach FireVoice a word from this">
                      <button type="button" aria-label="Fix a word" onMouseDown={(e) => e.preventDefault()} onClick={() => fixWord(h)} className="grid size-8 place-items-center rounded-[9px] text-muted hover:bg-surface-3/70 hover:text-ink">
                        <GraduationCap className="size-4" />
                      </button>
                    </Tooltip>
                    <Tooltip content="Copy">
                      <button type="button" aria-label="Copy this dictation" onClick={() => copy(h.text)} className="grid size-8 place-items-center rounded-[9px] text-muted hover:bg-surface-3/70 hover:text-ink">
                        <Copy className="size-4" />
                      </button>
                    </Tooltip>
                    <Tooltip content="Remove">
                      <button type="button" aria-label="Remove this dictation" onClick={() => del.mutate(h.id)} className="grid size-8 place-items-center rounded-[9px] text-muted hover:bg-bad-soft hover:text-bad">
                        <Trash2 className="size-4" />
                      </button>
                    </Tooltip>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {d && d.total > d.items.length && (
            <div className="flex justify-center pt-1">
              <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
                Show more ({d.total - d.items.length} left)
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Clear the whole dictation history?"
        description="Every saved dictation is deleted from this computer. Text already typed into other programs stays where it is."
        confirmLabel="Clear all"
        destructive
        loading={clear.isPending}
        onConfirm={() => clear.mutate()}
      />

      <Dialog
        open={teach != null}
        onOpenChange={(v) => !v && setTeach(null)}
        title="Teach FireVoice a word"
        description="When it writes the word on the left, it will put yours instead. It also learns to expect your spelling."
        footer={
          <>
            <Button variant="ghost" onClick={() => setTeach(null)}>
              Cancel
            </Button>
            <Button loading={learn.isPending} disabled={!teach?.heard.trim() || !teach?.write.trim()} onClick={() => teach && learn.mutate(teach)}>
              Save
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <Input autoFocus={!teach?.heard} value={teach?.heard ?? ""} onChange={(e) => setTeach((t) => t && { ...t, heard: e.target.value })} placeholder="It wrote" aria-label="It wrote" />
          <ArrowRight className="size-4 text-faint" />
          <Input autoFocus={!!teach?.heard} value={teach?.write ?? ""} onChange={(e) => setTeach((t) => t && { ...t, write: e.target.value })} placeholder="I meant" aria-label="I meant" />
        </div>
      </Dialog>
    </div>
  );
}
