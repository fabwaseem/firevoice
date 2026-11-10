import { Heart, Play, Pause, Star } from "lucide-react";
import { motion } from "motion/react";
import type { Voice } from "@/lib/api/types";
import { api } from "@/lib/api/client";
import { useUpdateVoice } from "@/lib/api/hooks";
import { usePlayer } from "@/stores/player";
import { cn, langName, truncate } from "@/lib/utils";
import { ArtTile, Badge, Equalizer, Tooltip } from "@/components/ui";
import { initials, genderLabel, kindLabel } from "./helpers";
import { QualityBadge } from "./QualityBadge";

export function VoiceCard({ voice, onOpen, index = 0 }: { voice: Voice; onOpen: (v: Voice) => void; index?: number }) {
  const update = useUpdateVoice();
  const isCurrent = usePlayer((s) => s.track?.id === voice.voice_id);
  const playing = usePlayer((s) => s.playing && s.track?.id === voice.voice_id);

  const togglePlay = () => {
    const player = usePlayer.getState();
    if (isCurrent) {
      player.toggle();
      return;
    }
    player.load({
      id: voice.voice_id,
      title: voice.name,
      subtitle: voice.has_preview ? "Introduction" : "Reference clip",
      src: voice.has_preview ? api.voicePreviewUrl(voice.voice_id) : api.voiceAudioUrl(voice.voice_id),
      format: voice.has_preview ? "mp3" : "wav",
      href: `/voices/${voice.voice_id}`,
    });
  };

  const clipCount = voice.styles?.length ?? 0;

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index, 12) * 0.025, ease: [0.25, 1, 0.5, 1] }}
      className={cn(
        "surface group relative flex flex-col gap-3 rounded-xl p-3 transition-[box-shadow,transform,border-color] hover:shadow-md hover:border-line-strong",
        isCurrent && "border-fire/40",
      )}
    >
      <div className="relative">
        <button
          type="button"
          onClick={() => onOpen(voice)}
          className="block w-full rounded-lg focus-visible:outline-2 focus-visible:outline-fire"
          aria-label={`Open ${voice.name}`}
        >
          <ArtTile seed={voice.voice_id} image={api.voiceAvatarUrl(voice)} className="aspect-square w-full text-[28px] font-bold tracking-tight">
            {playing ? <Equalizer className="h-6 text-white" /> : voice.avatar ? null : initials(voice.name)}
          </ArtTile>
        </button>

        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? `Pause ${voice.name}` : `Play ${voice.name} reference`}
          disabled={voice.has_ref === false}
          className={cn(
            "absolute right-2 bottom-2 flex size-10 items-center justify-center rounded-full bg-white text-[#16171c] shadow-md transition-[opacity,transform] hover:scale-105 active:scale-95 disabled:opacity-0",
            playing ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
        </button>

        <button
          type="button"
          onClick={() => update.mutate({ id: voice.voice_id, patch: { favorite: !voice.favorite } })}
          aria-label={voice.favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={!!voice.favorite}
          className={cn(
            "absolute top-2 right-2 flex size-8 items-center justify-center rounded-full bg-black/25 text-white backdrop-blur transition-[opacity,transform] hover:scale-110",
            voice.favorite ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Heart className={cn("size-4", voice.favorite && "fill-current")} />
        </button>

        {voice.default && (
          <Tooltip content="Default voice">
            <span className="absolute top-2 left-2 flex size-7 items-center justify-center rounded-full bg-white/90 text-fire shadow-sm">
              <Star className="size-3.5 fill-current" />
            </span>
          </Tooltip>
        )}
      </div>

      <button type="button" onClick={() => onOpen(voice)} className="min-w-0 text-left">
        <h3 className="truncate text-[14px] font-semibold text-ink">{voice.name}</h3>
        <p className="mt-0.5 min-h-[18px] truncate text-[12.5px] text-muted">
          {voice.tagline ? truncate(voice.tagline, 64) : voice.description ? truncate(voice.description, 60) : [genderLabel(voice.gender), voice.accent].filter(Boolean).join(" · ") || langName(voice.language)}
        </p>
      </button>

      <div className="flex flex-wrap items-center gap-1.5">
        <QualityBadge voice={voice} />
        {voice.kind && <Badge tone={voice.kind === "designed" ? "info" : "neutral"}>{kindLabel(voice.kind)}</Badge>}
        <Badge>{langName(voice.language)}</Badge>
        {voice.gender && <Badge>{genderLabel(voice.gender)}</Badge>}
        {clipCount > 0 && (
          <Badge tone="fire">
            {clipCount} style clip{clipCount === 1 ? "" : "s"}
          </Badge>
        )}
      </div>
    </motion.article>
  );
}

export function VoiceCardSkeleton() {
  return (
    <div className="surface flex flex-col gap-3 rounded-xl p-3" aria-hidden>
      <div className="skeleton aspect-square w-full rounded-lg" />
      <div className="skeleton h-4 w-2/3 rounded" />
      <div className="skeleton h-3 w-1/2 rounded" />
      <div className="flex gap-1.5">
        <div className="skeleton h-[22px] w-14 rounded-full" />
        <div className="skeleton h-[22px] w-16 rounded-full" />
      </div>
    </div>
  );
}
