import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { FilterX, Library, Plus } from "@/components/icons";
import { errMessage, useOptions, useVoiceCollections, useVoices } from "@/lib/api/hooks";
import type { Voice } from "@/lib/api/types";
import { Button, Chip, EmptyState } from "@/components/ui";
import { PageHeader, LoadError } from "@/components/shell/PageHeader";
import { VoiceCard, VoiceCardSkeleton } from "@/components/voices/VoiceCard";
import { VoiceFilters, EMPTY_FILTERS, type VoiceFilterState } from "@/components/voices/VoiceFilters";
import { VoiceDetail } from "@/components/voices/VoiceDetail";
import { NewVoiceDialog } from "@/components/voices/NewVoiceDialog";

export function VoicesView() {
  const { voiceId } = useParams();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<VoiceFilterState>(EMPTY_FILTERS);
  const [addOpen, setAddOpen] = useState(false);
  const [shelf, setShelf] = useState("");
  const collections = useVoiceCollections();

  // search as you type, without a request per keystroke
  const [q, setQ] = useState(filters.q);
  useEffect(() => {
    const t = setTimeout(() => setQ(filters.q), 250);
    return () => clearTimeout(t);
  }, [filters.q]);

  const options = useOptions();
  const voices = useVoices({ q: q || undefined, kind: filters.kind || undefined, gender: filters.gender || undefined, language: filters.language || undefined });

  const list = useMemo(() => {
    const all = voices.data ?? [];
    const inShelf = shelf ? new Set(collections.data?.find((c) => c.id === shelf)?.voices ?? []) : null;
    const filtered = all.filter((v) => (!filters.favorites || v.favorite) && (!inShelf || inShelf.has(v.voice_id)));
    const rank = (v: Voice) => v.quality?.rank ?? 999;
    return [...filtered].sort((a, b) =>
      shelf
        ? rank(a) - rank(b)
        : Number(b.default) - Number(a.default) || Number(!!b.favorite) - Number(!!a.favorite) || Number(!!b.featured) - Number(!!a.featured) || a.name.localeCompare(b.name),
    );
  }, [voices.data, filters.favorites, shelf, collections.data]);

  const open = (v: Voice) => navigate(`/voices/${v.voice_id}`);
  const close = () => navigate("/voices");
  const total = options.data?.voice_count ?? voices.data?.length;
  const hasAny = (voices.data?.length ?? 0) > 0 || Object.values(filters).some(Boolean);

  return (
    <div className="page-width">
      <PageHeader
        title="Voices"
        subtitle={total != null ? `${total} voice${total === 1 ? "" : "s"} in your library. Clone from a clip or design one from a description.` : "Your voice library."}
        actions={
          <Button variant="primary" leading={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>
            Add voice
          </Button>
        }
      />

      {!!collections.data?.length && (
        <div role="group" aria-label="Collections" className="mb-3 flex flex-wrap items-center gap-1.5">
          <Chip active={!shelf} onClick={() => setShelf("")}>
            All voices
          </Chip>
          {collections.data.map((c) => (
            <Chip key={c.id} active={shelf === c.id} onClick={() => setShelf(shelf === c.id ? "" : c.id)} title={c.description}>
              {c.title} <span className="text-faint">{c.voices.length}</span>
            </Chip>
          ))}
        </div>
      )}

      {hasAny && <VoiceFilters value={filters} onChange={setFilters} languages={options.data?.languages ?? []} />}

      {voices.isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4" role="status" aria-busy aria-label="Loading voices">
          {Array.from({ length: 10 }).map((_, i) => (
            <VoiceCardSkeleton key={i} />
          ))}
        </div>
      ) : voices.error ? (
        <LoadError message={errMessage(voices.error)} retry={() => void voices.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Library />}
          title={hasAny ? "No voices match" : "Your library is empty"}
          description={hasAny ? "Try a different search or clear the filters." : "Add a voice from a short reference clip, or design one from a description."}
          action={
            hasAny ? (
              <Button onClick={() => setFilters(EMPTY_FILTERS)} leading={<FilterX className="size-4" />}>Clear filters</Button>
            ) : (
              <Button variant="primary" leading={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>
                Add voice
              </Button>
            )
          }
          className="surface rounded-xl"
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
          {list.map((v, i) => (
            <VoiceCard key={v.voice_id} voice={v} onOpen={open} index={i} />
          ))}
        </div>
      )}

      <VoiceDetail voiceId={voiceId ?? null} onClose={close} />
      <NewVoiceDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
