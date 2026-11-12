import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { CheckSquare, History as HistoryIcon, Mic, Search, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { errMessage, useHistory } from "@/lib/api/hooks";
import type { HistoryItem, HistoryKind } from "@/lib/api/types";
import { dayGroup } from "@/lib/utils";
import { PageHeader, LoadError } from "@/components/shell/PageHeader";
import { HistoryRow, KIND } from "@/components/history/HistoryList";
import { Button, ConfirmDialog, EmptyState, Input, Segmented, Select, Skeleton } from "@/components/ui";
import { DictationHistoryPanel } from "@/components/dictation/DictationHistory";

type View = "made" | "dictation";
const PAGE = 60;
const KINDS: { value: HistoryKind | "all"; label: string }[] = [
  { value: "all", label: "All kinds" },
  ...(Object.keys(KIND) as HistoryKind[]).map((k) => ({ value: k, label: KIND[k].label })),
];
const key = (it: HistoryItem) => `${it.kind}:${it.id}`;

/** Everything made on this computer and everything dictated, newest first, by day: kept until you delete it.
 * ?kind=dictation opens on the dictations; ?kind=speech (or another kind) on that kind. */
export function HistoryView() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("kind");
  const view: View = raw === "dictation" ? "dictation" : "made";
  const kind = (raw && raw !== "dictation" && raw in KIND ? raw : "all") as HistoryKind | "all";
  const setView = (v: View) => setParams(v === "dictation" ? { kind: "dictation" } : {}, { replace: true });
  const setKind = (k: HistoryKind | "all") => setParams(k === "all" ? {} : { kind: k }, { replace: true });

  return (
    <div className="page-width fade-up">
      <PageHeader
        title="History"
        subtitle="Everything you've made and dictated, saved on this computer until you delete it."
        actions={
          <Segmented<View>
            ariaLabel="What to show"
            value={view}
            onChange={setView}
            options={[
              { value: "made", label: "Made", icon: <Sparkles className="size-3.5" /> },
              { value: "dictation", label: "Dictations", icon: <Mic className="size-3.5" /> },
            ]}
          />
        }
      />
      {view === "dictation" ? <DictationHistoryPanel /> : <Made kind={kind} setKind={setKind} />}
    </div>
  );
}

/** What was made: searchable, by kind, grouped by day, loading more as you scroll, and deletable a few at a time. */
function Made({ kind, setKind }: { kind: HistoryKind | "all"; setKind: (k: HistoryKind | "all") => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    setLimit(PAGE);
    setPicked(new Set());
  }, [kind, q]);

  const h = useHistory(kind === "all" ? undefined : kind, { limit, q: q || undefined });
  const items = useMemo(() => h.data ?? [], [h.data]);
  const more = items.length >= limit;

  // more as the end of the list comes into view
  useEffect(() => {
    const el = end.current;
    if (!el || !more) return;
    const io = new IntersectionObserver(
      (e) => {
        if (e[0]?.isIntersecting && !h.isFetching) setLimit((n) => n + PAGE);
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [more, h.isFetching, items.length]);

  const groups = useMemo(() => {
    const out: { label: string; items: HistoryItem[] }[] = [];
    for (const it of items) {
      const label = dayGroup(it.created);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(it);
      else out.push({ label, items: [it] });
    }
    return out;
  }, [items]);

  const toggle = (it: HistoryItem) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(key(it))) n.delete(key(it));
      else n.add(key(it));
      return n;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  const deletePicked = async () => {
    setDeleting(true);
    const chosen = items.filter((it) => picked.has(key(it)));
    let failed = 0;
    for (const it of chosen) {
      try {
        await api.deleteHistory(it);
      } catch {
        failed++;
      }
    }
    setDeleting(false);
    setConfirm(false);
    stopSelecting();
    void qc.invalidateQueries({ queryKey: ["history"] });
    if (failed) toast.error(`${failed} could not be deleted`);
    else toast.success(`Deleted ${chosen.length} item${chosen.length === 1 ? "" : "s"}`);
  };
  const filtered = !!q || kind !== "all";
  const allPicked = items.length > 0 && picked.size === items.length;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="w-full max-w-[300px] flex-1">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search titles" leading={<Search className="size-4" />} aria-label="Search history" />
        </div>
        <Select ariaLabel="Kind" className="w-44" value={kind} onChange={(v) => setKind(v as HistoryKind | "all")} options={KINDS} />
        <div className="ml-auto flex items-center gap-2">
          {selecting ? (
            <>
              <span className="text-[12.5px] text-muted tabular">{picked.size} selected</span>
              <Button size="sm" variant="ghost" onClick={() => setPicked(allPicked ? new Set() : new Set(items.map(key)))}>
                {allPicked ? "Select none" : "Select all"}
              </Button>
              <Button size="sm" variant="danger" leading={<Trash2 className="size-3.5" />} disabled={!picked.size} onClick={() => setConfirm(true)}>
                Delete
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Stop selecting" onClick={stopSelecting}>
                <X className="size-4" />
              </Button>
            </>
          ) : (
            items.length > 0 && (
              <Button size="sm" variant="ghost" leading={<CheckSquare className="size-3.5" />} onClick={() => setSelecting(true)}>
                Select
              </Button>
            )
          )}
        </div>
      </div>

      {h.isError ? (
        <LoadError message={errMessage(h.error)} retry={() => void h.refetch()} />
      ) : h.isLoading ? (
        <div className="surface space-y-1.5 rounded-xl p-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="surface rounded-xl p-1.5">
          <EmptyState
            icon={<HistoryIcon />}
            title={filtered ? "Nothing matches" : "Nothing here yet"}
            description={filtered ? "Try another search or kind." : "Speech, sounds, music, voice changes, dialogues and transcripts are saved here as you make them."}
            action={
              filtered ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setText("");
                    setKind("all");
                  }}
                >
                  Show everything
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <h2 className="mb-1.5 flex items-baseline gap-2 px-1 text-[11.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                {g.label}
              </h2>
              <div className="surface divide-y divide-line/60 rounded-xl p-1.5">
                {g.items.map((it) => (
                  <HistoryRow key={key(it)} item={it} select={selecting ? { on: picked.has(key(it)), toggle: () => toggle(it) } : undefined} />
                ))}
              </div>
            </section>
          ))}
          <div ref={end} className="flex h-10 items-center justify-center text-[12px] text-faint">
            {more ? (h.isFetching ? "Loading more…" : "") : items.length > 8 ? "That's everything" : ""}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${picked.size} item${picked.size === 1 ? "" : "s"} from History?`}
        description="They and their files are removed from this computer. This cannot be undone."
        confirmLabel="Delete"
        destructive
        loading={deleting}
        onConfirm={() => void deletePicked()}
      />
    </>
  );
}
