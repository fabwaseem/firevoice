import { Link, useNavigate } from "react-router";
import { Library, Star } from "lucide-react";
import { ArtTile, Card, CardBody, CardHeader, EmptyState, Skeleton, Tooltip } from "@/components/ui";
import { useVoices } from "@/lib/api/hooks";
import type { Voice } from "@/lib/api/types";

function initials(v: Voice): string {
  const parts = v.name.trim().split(/[\s_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || v.voice_id.slice(0, 2).toUpperCase();
}

export function VoicesCard() {
  const voices = useVoices();
  const navigate = useNavigate();
  const list = [...(voices.data ?? [])].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || Number(b.default) - Number(a.default));
  const shown = list.slice(0, 8);
  const more = list.length - shown.length;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title="Voices"
        description={voices.data ? `${voices.data.length} in your library` : "Loading library…"}
        action={
          <Link to="/voices" className="text-[12.5px] font-medium text-fire hover:underline">
            Library
          </Link>
        }
      />
      <CardBody className="flex flex-1 items-center">
        {voices.isLoading ? (
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="size-11 rounded-xl" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState icon={<Library />} title="No voices yet" description="Clone one from a clip or design one from a sentence." className="w-full py-6" />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {shown.map((v) => (
              <Tooltip key={v.voice_id} content={`${v.name}${v.default ? " · default" : ""}`}>
                <button
                  type="button"
                  aria-label={`Open voice ${v.name}`}
                  onClick={() => navigate(`/voices/${encodeURIComponent(v.voice_id)}`)}
                  className="relative rounded-xl transition-transform hover:-translate-y-0.5 focus-visible:-translate-y-0.5"
                >
                  <ArtTile seed={v.voice_id} className="size-11 rounded-xl text-[13px] font-semibold">
                    {initials(v)}
                  </ArtTile>
                  {v.favorite && (
                    <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-surface text-warn shadow-sm" aria-hidden>
                      <Star className="size-2.5 fill-current" />
                    </span>
                  )}
                </button>
              </Tooltip>
            ))}
            {more > 0 && (
              <Link
                to="/voices"
                className="flex size-11 items-center justify-center rounded-xl border border-dashed border-line-strong text-[12px] font-medium text-muted hover:text-ink"
              >
                +{more}
              </Link>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
