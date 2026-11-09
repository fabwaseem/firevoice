import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Library, Plus, Sparkles } from "lucide-react";
import { errMessage, useOptions, useVoices } from "@/lib/api/hooks";
import type { Voice } from "@/lib/api/types";
import { Button, EmptyState } from "@/components/ui";
import { PageHeader, LoadError } from "@/components/shell/PageHeader";
import { VoiceCard, VoiceCardSkeleton } from "@/components/voices/VoiceCard";
import { VoiceFilters, EMPTY_FILTERS, type VoiceFilterState } from "@/components/voices/VoiceFilters";
import { VoiceDetail } from "@/components/voices/VoiceDetail";
import { AddVoiceDialog } from "@/components/voices/AddVoiceDialog";
import { DesignVoiceDialog } from "@/components/voices/DesignVoiceDialog";

export function VoicesView() {
  const { voiceId } = useParams();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<VoiceFilterState>(EMPTY_FILTERS);
  const [addOpen, setAddOpen] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);

  const options = useOptions();
  const voices = useVoices({ q: filters.q || undefined, kind: filters.kind || undefined, gender: filters.gender || undefined, language: filters.language || undefined });

  const list = useMemo(() => {
    const all = voices.data ?? [];
    const filtered = filters.favorites ? all.filter((v) => v.favorite) : all;
    return [...filtered].sort((a, b) => Number(b.default) - Number(a.default) || Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name));
  }, [voices.data, filters.favorites]);

  const open = (v: Voice) => navigate(`/voices/${v.voice_id}`);
  const close = () => navigate("/voices");
  const total = options.data?.voice_count ?? voices.data?.length;
  const hasAny = (voices.data?.length ?? 0) > 0 || Object.values(filters).some(Boolean);

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Voices"
        subtitle={total != null ? `${total} voice${total === 1 ? "" : "s"} in your library. Clone from a clip or design one from a description.` : "Your voice library."}
        actions={
          <>
            <Button leading={<Sparkles className="size-4" />} onClick={() => setDesignOpen(true)}>
              Design voice
            </Button>
            <Button variant="primary" leading={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>
              Add voice
            </Button>
          </>
        }
      />

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
              <Button onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</Button>
            ) : (
              <div className="flex gap-2">
                <Button leading={<Sparkles className="size-4" />} onClick={() => setDesignOpen(true)}>
                  Design voice
                </Button>
                <Button variant="primary" leading={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>
                  Add voice
                </Button>
              </div>
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
      <AddVoiceDialog open={addOpen} onOpenChange={setAddOpen} />
      <DesignVoiceDialog open={designOpen} onOpenChange={setDesignOpen} />
    </div>
  );
}
