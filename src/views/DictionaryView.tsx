import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookA, Download, Play, Plus, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api/client";
import { errMessage, qk, useDictionary, useOptions } from "@/lib/api/hooks";
import type { DictRule, DictRuleInput } from "@/lib/api/types";
import { saveBlob } from "@/lib/audio";
import { useStudio } from "@/stores/studio";
import { PageHeader, LoadError } from "@/components/shell/PageHeader";
import { Button, Card, EmptyState, Input, Label, Skeleton, Switch, Tooltip } from "@/components/ui";

/** Pronunciation dictionary: your rules for how names, brands and acronyms are said. */
export function DictionaryView() {
  const qc = useQueryClient();
  const q = useDictionary();
  const options = useOptions();
  const studio = useStudio();
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<DictRuleInput>({ match: "", say: "", case: false, whole_word: true });
  const [adding, setAdding] = useState(false);
  const [test, setTest] = useState("");
  const [spoken, setSpoken] = useState("");
  const [hearing, setHearing] = useState(false);
  const engine = studio.engine ?? options.data?.default_engine ?? null;

  const refresh = () => qc.invalidateQueries({ queryKey: qk.dictionary });

  const add = async () => {
    if (!draft.match.trim()) {
      toast.error("Write the word as it appears in scripts");
      return;
    }
    setAdding(true);
    try {
      await api.addRule({ ...draft, match: draft.match.trim(), say: draft.say.trim() });
      toast.success(`Added ${draft.match.trim()}`);
      setDraft({ match: "", say: "", case: false, whole_word: true });
      refresh();
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setAdding(false);
    }
  };

  const show = async () => {
    if (!test.trim()) return;
    try {
      setSpoken((await api.testDictionary(test, engine)).spoken);
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
      const r = await api.tts({ text: test, engine, voice: studio.voice, style: studio.style, format: "mp3" });
      const a = new Audio(URL.createObjectURL(r.blob));
      await a.play();
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setHearing(false);
    }
  };

  const exportRules = async () => {
    const rules = (q.data?.rules ?? []).map(({ match, say, case: c, whole_word, note }) => ({ match, say, case: c, whole_word, note }));
    await saveBlob(new Blob([JSON.stringify({ rules }, null, 1)], { type: "application/json" }), "firevoice-dictionary.json");
  };

  const importRules = async (f: File) => {
    try {
      const data = JSON.parse(await f.text());
      let rules = Array.isArray(data) ? data : data.rules ?? data;
      if (!Array.isArray(rules)) rules = Object.entries(rules as Record<string, string>).map(([match, say]) => ({ match, say }));
      if (!window.confirm(`Replace your ${q.data?.rules.length ?? 0} rule(s) with ${rules.length} from ${f.name}?`)) return;
      await api.replaceRules(rules);
      toast.success(`Imported ${rules.length} rule(s)`);
      refresh();
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title="Dictionary"
        subtitle="Your rules for how names, brands and acronyms are said. They run before everything else and work in every language."
        actions={
          <>
            <Button variant="outline" leading={<Upload className="size-4" />} onClick={() => fileRef.current?.click()}>Import</Button>
            <Button variant="outline" leading={<Download className="size-4" />} onClick={exportRules} disabled={!q.data?.rules.length}>Export</Button>
          </>
        }
      />
      <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void importRules(f); e.target.value = ""; }} />

      <Card className="mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <div>
            <Label htmlFor="d-match">Written</Label>
            <Input id="d-match" value={draft.match} placeholder="Ayesha, SQL, Nguyen" onChange={(e) => setDraft({ ...draft, match: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="d-say">Say it as</Label>
            <Input id="d-say" value={draft.say} placeholder="Aa-ye-sha, sequel, Win" onChange={(e) => setDraft({ ...draft, say: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
          </div>
          <Button variant="primary" leading={<Plus className="size-4" />} onClick={add} loading={adding}>Add rule</Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-6">
          <Switch checked={!!draft.case} onChange={(v) => setDraft({ ...draft, case: v })} label="Exact casing only" />
          <Switch checked={!draft.whole_word} onChange={(v) => setDraft({ ...draft, whole_word: !v })} label="Also inside longer words" />
        </div>
      </Card>

      <Card className="mb-4 p-2">
        {q.isLoading ? (
          <div className="space-y-2 p-2"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
        ) : q.isError ? (
          <LoadError message={errMessage(q.error)} retry={() => void q.refetch()} />
        ) : q.data && q.data.rules.length ? (
          <div className="divide-y divide-line">
            {q.data.rules.map((r) => <RuleRow key={r.id} r={r} onChanged={refresh} />)}
          </div>
        ) : (
          <EmptyState icon={<BookA className="size-5" />} title="No rules yet" description="Add a name or word the voices say wrong." />
        )}
      </Card>

      <Card className="mb-4 p-4">
        <Label>Try it</Label>
        <div className="flex gap-2">
          <Input value={test} placeholder="Type a sentence to see what the engine will read" onChange={(e) => setTest(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void show(); }} />
          <Button variant="outline" onClick={show}>Show</Button>
          <Button variant="outline" leading={<Play className="size-4" />} onClick={hear} loading={hearing}>Hear it</Button>
        </div>
        {spoken && <p className="mt-3 font-mono text-[14px] text-ink">{spoken}</p>}
      </Card>

      <details className="rounded-2xl border border-line bg-surface p-4">
        <summary className="cursor-pointer text-[14px] font-semibold text-ink">
          Built-in list <span className="ml-2 text-[12.5px] font-normal text-muted">numbers, money, dates and these words are handled automatically; your rule for the same word wins</span>
        </summary>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(q.data?.builtin ?? []).map((b) => (
            <span key={b.match} className="rounded-full bg-surface-3 px-2.5 py-1 text-[12.5px] text-ink-2"><b className="mr-1 text-ink">{b.match}</b>{b.say}</span>
          ))}
        </div>
      </details>
    </div>
  );
}

function RuleRow({ r, onChanged }: { r: DictRule; onChanged: () => void }) {
  const [v, setV] = useState(r);
  const first = useRef(true);
  useEffect(() => setV(r), [r]);
  // save edits half a second after typing stops
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => {
      api.updateRule(r.id, { match: v.match, say: v.say, case: v.case, whole_word: v.whole_word }).catch((e) => toast.error(errMessage(e)));
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.match, v.say, v.case, v.whole_word]);

  const remove = async () => {
    try {
      await api.removeRule(r.id);
      onChanged();
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  return (
    <div className="grid items-center gap-3 px-2 py-2 md:grid-cols-[1fr_1fr_auto_auto]">
      <Input aria-label="Written" value={v.match} onChange={(e) => setV({ ...v, match: e.target.value })} />
      <Input aria-label="Said as" value={v.say} onChange={(e) => setV({ ...v, say: e.target.value })} />
      <div className="flex gap-4">
        <Switch checked={v.case} onChange={(c) => setV({ ...v, case: c })} label="Exact case" />
        <Switch checked={!v.whole_word} onChange={(c) => setV({ ...v, whole_word: !c })} label="Inside words" />
      </div>
      <Tooltip content="Delete rule">
        <Button size="icon-sm" variant="ghost" aria-label={`Delete ${r.match}`} onClick={remove}><Trash2 className="size-4" /></Button>
      </Tooltip>
    </div>
  );
}
