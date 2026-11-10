import { useEffect, useState } from "react";
import { History as HistoryIcon, Search } from "lucide-react";
import { useHistory } from "@/lib/api/hooks";
import type { HistoryKind } from "@/lib/api/types";
import { PageHeader, LoadError } from "@/components/shell/PageHeader";
import { HistoryRow, KIND } from "@/components/history/HistoryList";
import { Button, Chip, EmptyState, Input, Skeleton } from "@/components/ui";
import { errMessage } from "@/lib/api/hooks";

const FILTERS: { value: HistoryKind | "all"; label: string }[] = [
  { value: "all", label: "Everything" },
  ...(Object.keys(KIND) as HistoryKind[]).map((k) => ({ value: k, label: KIND[k].label })),
];

/** Everything made on this computer, newest first: kept until you delete it. */
export function HistoryView() {
  const [kind, setKind] = useState<HistoryKind | "all">("all");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(60);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => setLimit(60), [kind, q]);

  const h = useHistory(kind === "all" ? undefined : kind, { limit, q: q || undefined });
  const items = h.data ?? [];
  const more = items.length >= limit;

  return (
    <div className="mx-auto max-w-[1000px] fade-up">
      <PageHeader title="History" subtitle="Everything you've made, saved on this computer until you delete it." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="w-full max-w-[280px]">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search titles" leading={<Search className="size-4" />} aria-label="Search history" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <Chip key={f.value} active={kind === f.value} onClick={() => setKind(f.value)}>
              {f.label}
            </Chip>
          ))}
        </div>
      </div>

      {h.isError ? (
        <LoadError message={errMessage(h.error)} retry={() => void h.refetch()} />
      ) : (
        <div className="surface rounded-xl p-1.5">
          {h.isLoading ? (
            <div className="space-y-1.5 p-1.5">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<HistoryIcon />}
              title={q || kind !== "all" ? "Nothing matches" : "Nothing here yet"}
              description={q || kind !== "all" ? "Try another search or filter." : "Speech, sounds, music, voice changes, dialogues and transcripts are saved here as you make them."}
            />
          ) : (
            <div className="divide-y divide-line/60">{items.map((it) => <HistoryRow key={`${it.kind}:${it.id}`} item={it} />)}</div>
          )}
        </div>
      )}
      {more && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" loading={h.isFetching} onClick={() => setLimit((n) => n + 60)}>
            Show more
          </Button>
        </div>
      )}
    </div>
  );
}
