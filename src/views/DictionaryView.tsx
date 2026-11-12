import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AudioLines, BookA, ChevronDown, Download, Eye, Keyboard, Mic, Play, Plus, Search, Trash2, Upload, Volume2, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { errMessage, qk, useDictionary, useOptions } from "@/lib/api/hooks";
import type { DictRule, DictRuleInput } from "@/lib/api/types";
import { saveBlob } from "@/lib/audio";
import { cn } from "@/lib/utils";
import { useStudio } from "@/stores/studio";
import { PageHeader, LoadError } from "@/components/shell/PageHeader";
import { Button, Card, ConfirmDialog, EmptyState, Input, Label, Skeleton, Switch, Tooltip } from "@/components/ui";
import { VOCAB_KEY } from "@/components/dictation/DictationVocabulary";

/** One clip at a time for the Hear buttons: released when replaced or when the page closes. */
function useClip() {
  const clip = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const release = () => {
    if (!clip.current) return;
    clip.current.audio.pause();
    URL.revokeObjectURL(clip.current.url);
    clip.current = null;
  };
  useEffect(() => release, []);
  const engine = useStudio((s) => s.engine);
  const voice = useStudio((s) => s.voice);
  const style = useStudio((s) => s.style);
  const options = useOptions();
  const play = async (text: string) => {
    const r = await api.tts({ text, engine: engine ?? options.data?.default_engine ?? null, voice, style, format: "mp3" });
    release();
    const url = URL.createObjectURL(r.blob);
    const audio = new Audio(url);
    clip.current = { audio, url };
    await audio.play();
  };
  return { play, engine: engine ?? options.data?.default_engine ?? null };
}

/** Your dictionary: names, brands and terms, used everywhere. The voices say them your way ("Say it as"), dictation
 * and transcription expect and spell them your way, and dictation fixes what it mishears ("Also heard as"). */
export function DictionaryView() {
  const qc = useQueryClient();
  const q = useDictionary();
  const clip = useClip();
  const fileRef = useRef<HTMLInputElement>(null);
  const wordRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<{ match: string; say: string }>({ match: "", say: "" });
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [test, setTest] = useState("");
  const [spoken, setSpoken] = useState("");
  const [hearing, setHearing] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ name: string; rules: DictRuleInput[] } | null>(null);
  const [importing, setImporting] = useState(false);

  const rules = q.data?.rules ?? [];
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = [...rules].reverse(); // newest first
    return f ? list.filter((r) => [r.match, r.say, ...(r.heard ?? [])].some((x) => x.toLowerCase().includes(f))) : list;
  }, [rules, filter]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.dictionary });
    void qc.invalidateQueries({ queryKey: VOCAB_KEY });
  };

  const add = async () => {
    const match = draft.match.trim();
    if (!match) {
      wordRef.current?.focus();
      return;
    }
    setAdding(true);
    try {
      await api.addRule({ match, say: draft.say.trim(), case: false, whole_word: true });
      toast.success(`Added ${match}`);
      setDraft({ match: "", say: "" });
      refresh();
      wordRef.current?.focus();
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setAdding(false);
    }
  };

  const show = async () => {
    if (!test.trim()) return;
    try {
      setSpoken((await api.testDictionary(test, clip.engine)).spoken);
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  const hear = async () => {
    if (!test.trim()) {
      toast.error("Type a sentence first");
      return;
    }
    setHearing(true);
    try {
      await clip.play(test);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setHearing(false);
    }
  };

  const exportRules = async () => {
    const out = rules.map(({ match, say, case: c, whole_word, note, heard }) => ({ match, say, case: c, whole_word, note, heard }));
    await saveBlob(new Blob([JSON.stringify({ rules: out }, null, 1)], { type: "application/json" }), "firevoice-dictionary.json");
  };

  const importRules = async (f: File) => {
    try {
      const data = JSON.parse(await f.text());
      let list = Array.isArray(data) ? data : data.rules ?? data;
      if (!Array.isArray(list)) list = Object.entries(list as Record<string, string>).map(([match, say]) => ({ match, say }));
      setPendingImport({ name: f.name, rules: list });
    } catch (e) {
      toast.error(e instanceof SyntaxError ? "That file is not a dictionary FireVoice can read." : errMessage(e));
    }
  };

  const confirmImport = async () => {
    if (!pendingImport) return;
    setImporting(true);
    try {
      await api.replaceRules(pendingImport.rules);
      toast.success(`Imported ${pendingImport.rules.length} word${pendingImport.rules.length === 1 ? "" : "s"}`);
      refresh();
      setPendingImport(null);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="page-width fade-up">
      <PageHeader
        title="Dictionary"
        subtitle="Your names, brands and terms, in one place. Voices say them your way; dictation and transcription spell them your way."
        actions={
          <>
            <Button variant="outline" leading={<Upload className="size-4" />} onClick={() => fileRef.current?.click()}>
              Import
            </Button>
            <Button variant="outline" leading={<Download className="size-4" />} onClick={exportRules} disabled={!rules.length}>
              Export
            </Button>
          </>
        }
      />
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importRules(f);
          e.target.value = "";
        }}
      />

      {/* where your words are used */}
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        {[
          { icon: AudioLines, title: "Voices", text: "Say it your way, with “Say it as”." },
          { icon: Keyboard, title: "Dictation", text: "Spelled your way, and fixed when misheard." },
          { icon: Mic, title: "Transcription", text: "Expected and spelled your way." },
        ].map(({ icon: Icon, title, text }) => (
          <div key={title} className="flex items-start gap-2.5 rounded-[12px] bg-surface-2 px-3.5 py-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-fire-soft text-fire">
              <Icon className="size-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-ink">{title}</span>
              <span className="block text-[12px] leading-snug text-muted">{text}</span>
            </span>
          </div>
        ))}
      </div>

      {/* add a word */}
      <Card className="mb-4 p-4">
        <form
          className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div>
            <Label htmlFor="d-match">Word</Label>
            <Input ref={wordRef} id="d-match" value={draft.match} placeholder="FireVoice, Siobhan, SQL" onChange={(e) => setDraft({ ...draft, match: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="d-say" hint="optional">
              Say it as
            </Label>
            <Input id="d-say" value={draft.say} placeholder="Shi-vawn, sequel" onChange={(e) => setDraft({ ...draft, say: e.target.value })} />
          </div>
          <Button type="submit" variant="primary" leading={<Plus className="size-4" />} loading={adding} disabled={!draft.match.trim()}>
            Add word
          </Button>
        </form>
        <p className="mt-2.5 text-[12px] text-faint">Leave “Say it as” empty when the voices already say it right: dictation still spells it your way.</p>
      </Card>

      {/* your words */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <span className="text-[14px] font-semibold text-ink">
            Your words {rules.length > 0 && <span className="ml-1 font-normal text-muted tabular">{rules.length}</span>}
          </span>
          {rules.length > 6 && (
            <Input
              aria-label="Find a word"
              className="h-8 w-56"
              leading={<Search className="size-3.5" />}
              placeholder="Find a word"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
        </div>
        {q.isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : q.isError ? (
          <LoadError message={errMessage(q.error)} retry={() => void q.refetch()} />
        ) : rules.length === 0 ? (
          <EmptyState icon={<BookA className="size-5" />} title="No words yet" description="Add a name FireVoice says or spells wrong." />
        ) : shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted">No word matches “{filter}”.</p>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((r) => (
              <WordRow key={r.id} r={r} onChanged={refresh} play={clip.play} />
            ))}
          </ul>
        )}
      </Card>

      {/* try it */}
      <Card className="mb-4 p-4">
        <Label icon={<Play />}>Try it</Label>
        <div className="flex gap-2">
          <Input
            value={test}
            placeholder="Type a sentence to see what the voices will read"
            onChange={(e) => setTest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void show();
            }}
          />
          <Button variant="outline" onClick={show} leading={<Eye className="size-4" />}>
            Show
          </Button>
          <Button variant="outline" leading={<Play className="size-4" />} onClick={hear} loading={hearing}>
            Hear it
          </Button>
        </div>
        {spoken && <p className="mt-3 font-mono text-[14px] text-ink">{spoken}</p>}
      </Card>

      <details className="rounded-2xl border border-line bg-surface p-4">
        <summary className="cursor-pointer text-[14px] font-semibold text-ink">
          Built-in list{" "}
          <span className="ml-2 text-[12.5px] font-normal text-muted">numbers, money, dates and these words are read correctly already; your word wins over them</span>
        </summary>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(q.data?.builtin ?? []).map((b) => (
            <span key={b.match} className="rounded-full bg-surface-3 px-2.5 py-1 text-[12.5px] text-ink-2">
              <b className="mr-1 text-ink">{b.match}</b>
              {b.say}
            </span>
          ))}
        </div>
      </details>

      <ConfirmDialog
        open={!!pendingImport}
        onOpenChange={(v) => !v && setPendingImport(null)}
        title="Replace your dictionary?"
        description={
          pendingImport
            ? `Your ${rules.length} word${rules.length === 1 ? "" : "s"} will be replaced with ${pendingImport.rules.length} from ${pendingImport.name}.`
            : undefined
        }
        confirmLabel="Replace"
        destructive
        loading={importing}
        onConfirm={() => void confirmImport()}
      />
    </div>
  );
}

function WordRow({ r, onChanged, play }: { r: DictRule; onChanged: () => void; play: (text: string) => Promise<void> }) {
  const [v, setV] = useState(r);
  const [open, setOpen] = useState(false);
  const [heardDraft, setHeardDraft] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const first = useRef(true);
  useEffect(() => setV(r), [r]);
  // save edits half a second after typing stops
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!v.match.trim()) return;
    const t = setTimeout(() => {
      api
        .updateRule(r.id, { match: v.match, say: v.say, case: v.case, whole_word: v.whole_word })
        .then(onChanged)
        .catch((e) => toast.error(errMessage(e)));
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.match, v.say, v.case, v.whole_word]);

  const heard = v.heard ?? [];
  const setHeard = async (next: string[]) => {
    setV({ ...v, heard: next });
    try {
      await api.updateRule(r.id, { heard: next });
      onChanged();
    } catch (e) {
      toast.error(errMessage(e));
    }
  };
  const addHeard = () => {
    const h = (heardDraft ?? "").trim();
    setHeardDraft(null);
    if (h && !heard.some((x) => x.toLowerCase() === h.toLowerCase()) && h.toLowerCase() !== v.match.toLowerCase()) void setHeard([...heard, h]);
  };
  const remove = async () => {
    try {
      await api.removeRule(r.id);
      onChanged();
    } catch (e) {
      toast.error(errMessage(e));
    }
  };
  const hear = async () => {
    setPlaying(true);
    try {
      await play(v.match);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setPlaying(false);
    }
  };

  return (
    <li className="group px-4 py-3">
      <div className="grid items-start gap-3 md:grid-cols-[1fr_1fr_auto]">
        <div className="min-w-0">
          <Input aria-label="Word" className="font-medium" value={v.match} onChange={(e) => setV({ ...v, match: e.target.value })} />
          {/* what dictation writes by mistake for this word */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11.5px] text-faint">Also heard as</span>
            {heard.map((h) => (
              <span key={h} className="inline-flex h-6 items-center gap-0.5 rounded-full bg-surface-2 pr-0.5 pl-2.5 text-[12px] text-ink-2">
                {h}
                <button
                  type="button"
                  aria-label={`Remove ${h}`}
                  onClick={() => void setHeard(heard.filter((x) => x !== h))}
                  className="grid size-5 place-items-center rounded-full text-faint hover:bg-surface-3 hover:text-ink"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {heardDraft === null ? (
              <button
                type="button"
                onClick={() => setHeardDraft("")}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-line px-2 text-[12px] text-muted hover:border-fire/50 hover:text-fire"
              >
                <Plus className="size-3" /> {heard.length ? "Add" : "Add a misheard form"}
              </button>
            ) : (
              <input
                autoFocus
                aria-label="What dictation writes by mistake"
                value={heardDraft}
                placeholder="e.g. fire voice"
                onChange={(e) => setHeardDraft(e.target.value)}
                onBlur={addHeard}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addHeard();
                  if (e.key === "Escape") setHeardDraft(null);
                }}
                className="h-6 w-36 rounded-full border border-fire/40 bg-surface px-2.5 text-[12px] text-ink outline-none"
              />
            )}
          </div>
        </div>
        <Input aria-label="Say it as" value={v.say} placeholder="Said as written" onChange={(e) => setV({ ...v, say: e.target.value })} />
        <div className="flex items-center gap-1">
          <Tooltip content="Hear it">
            <Button size="icon-sm" variant="ghost" aria-label={`Hear ${v.match}`} onClick={hear} loading={playing}>
              <Volume2 className="size-4" />
            </Button>
          </Tooltip>
          <Tooltip content="Options">
            <Button size="icon-sm" variant="ghost" aria-label="Options" aria-expanded={open} onClick={() => setOpen(!open)}>
              <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
            </Button>
          </Tooltip>
          <Tooltip content="Delete">
            <Button size="icon-sm" variant="ghost" aria-label={`Delete ${r.match}`} onClick={remove} className="hover:text-bad">
              <Trash2 className="size-4" />
            </Button>
          </Tooltip>
        </div>
      </div>
      {open && (
        <div className="mt-3 flex flex-wrap gap-6 rounded-[10px] bg-surface-2 px-3 py-2.5">
          <Switch checked={v.case} onChange={(c) => setV({ ...v, case: c })} label="Exact casing only" />
          <Switch checked={!v.whole_word} onChange={(c) => setV({ ...v, whole_word: !c })} label="Also inside longer words" />
        </div>
      )}
    </li>
  );
}
