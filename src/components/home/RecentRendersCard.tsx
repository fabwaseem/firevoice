import { Link } from "react-router";
import { History, Play, Pause } from "lucide-react";
import { ArtTile, Badge, Card, CardBody, CardHeader, EmptyState, Skeleton, Tooltip } from "@/components/ui";
import { useJobs, useEngineName, useVoices } from "@/lib/api/hooks";
import type { Job } from "@/lib/api/types";
import { usePlayer } from "@/stores/player";
import { relTime } from "@/lib/utils";
import { hasAudio, jobAudioSrc, jobTitle, kindLabel, statusLabel } from "@/components/jobs/jobUtils";

const STATUS_TONE: Record<Job["status"], "ok" | "info" | "warn" | "bad" | "neutral"> = {
  done: "ok",
  running: "info",
  queued: "warn",
  failed: "bad",
  cancelled: "neutral",
};

function jobSubtitle(j: Job, nameOf: (id?: string | null) => string, voiceName: (id?: string) => string | undefined): string | undefined {
  const r = (j.result ?? {}) as Record<string, unknown>;
  const p = (j.payload ?? {}) as Record<string, unknown>;
  const req = (p.request ?? {}) as Record<string, unknown>;
  const engine = (r.engine as string) ?? (req.engine as string);
  const voice = (r.voice as string) ?? (req.voice as string);
  return [nameOf(engine), voiceName(voice)].filter(Boolean).join(" · ") || undefined;
}

const NOT_RENDERS = new Set<string>(["install", "voices", "writer"]);

export function RecentRendersCard() {
  const jobs = useJobs({ limit: 20 });
  const nameOf = useEngineName();
  const voices = useVoices();
  const currentId = usePlayer((s) => s.track?.id);
  const playing = usePlayer((s) => s.playing);
  // renders only: installs, the voice library and the writing assistant are not things you made
  const list = (jobs.data?.jobs ?? []).filter((j) => !NOT_RENDERS.has(j.kind)).slice(0, 6);
  const voiceName = (id?: string) => (id ? (voices.data ?? []).find((v) => v.voice_id === id)?.name || (id === "default" ? "Default voice" : id) : undefined);

  const play = (j: Job) => {
    const player = usePlayer.getState();
    if (player.track?.id === j.id) {
      player.toggle();
      return;
    }
    player.load({ id: j.id, title: jobTitle(j), subtitle: jobSubtitle(j, nameOf, voiceName), src: jobAudioSrc(j), href: `/jobs/${j.id}` });
  };

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title="Recent renders"
        description="Your latest work, newest first."
        action={
          <Link to="/jobs" className="text-[12.5px] font-medium text-fire hover:underline">
            All jobs
          </Link>
        }
      />
      <CardBody className="flex-1 px-3 pb-3">
        {jobs.isLoading ? (
          <ul className="space-y-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 px-2 py-2">
                <Skeleton className="size-10 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </li>
            ))}
          </ul>
        ) : list.length === 0 ? (
          <EmptyState icon={<History />} title="No renders yet" description="Long scripts, batches and designed voices show up here." className="py-8" />
        ) : (
          <ul role="list" className="divide-y divide-line">
            {list.map((j) => {
              const active = currentId === j.id;
              const isPlaying = active && playing;
              const playable = hasAudio(j);
              const title = jobTitle(j);
              return (
                <li key={j.id} className="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2">
                  <div className="relative shrink-0">
                    <ArtTile seed={j.id} className="size-10 text-[12px] font-semibold">
                      {title.slice(0, 2).toUpperCase()}
                    </ArtTile>
                    {playable && (
                      <Tooltip content={isPlaying ? "Pause" : "Play"}>
                        <button
                          type="button"
                          aria-label={isPlaying ? `Pause ${title}` : `Play ${title}`}
                          onClick={() => play(j)}
                          className={`absolute inset-0 flex items-center justify-center rounded-lg bg-ink/45 text-white transition-opacity ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
                        >
                          {isPlaying ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
                        </button>
                      </Tooltip>
                    )}
                  </div>
                  <Link to={`/jobs/${j.id}`} className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-ink">{title}</span>
                    <span className="block truncate text-[12px] text-muted">{jobSubtitle(j, nameOf, voiceName) ?? kindLabel(j.kind)} · {relTime(j.finished ?? j.created)}</span>
                  </Link>
                  <Badge tone={STATUS_TONE[j.status]} dot={j.status === "running"}>
                    {j.status === "running" ? `${Math.round((j.progress ?? 0) * 100)}%` : statusLabel(j.status)}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
