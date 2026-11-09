import { AudioLines, Ban, BookOpen, Download, HardDriveDownload, Layers, MessagesSquare, Palette, Play, Sparkles, Trash2 } from "lucide-react";
import type { Job } from "@/lib/api/types";
import { api } from "@/lib/api/client";
import { saveBlob } from "@/lib/audio";
import { toast } from "sonner";
import { cn, fmtDuration, relTime } from "@/lib/utils";
import { usePlayer } from "@/stores/player";
import { ArtTile, Badge, Button, Equalizer, ProgressBar, Tooltip } from "@/components/ui";
import { errorText, hasAudio, isTerminal, jobTitle, kindLabel, resultNumber, statusTone } from "./jobUtils";

const KIND_ICON: Record<Job["kind"], typeof AudioLines> = {
  tts: AudioLines, batch: Layers, design: Sparkles, previews: Play, project: BookOpen, style_refs: Palette, dialogue: MessagesSquare, install: HardDriveDownload,
};

export function JobRow({
  job,
  selected,
  onSelect,
  onCancel,
  onDelete,
}: {
  job: Job;
  selected: boolean;
  onSelect: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const player = usePlayer();
  const Icon = KIND_ICON[job.kind] ?? AudioLines;
  const title = jobTitle(job);
  // window.open does nothing useful in the desktop webview (or leaks a token-bearing URL to the browser): fetch the
  // file and save it through the system save dialog instead
  const download = async () => {
    try {
      const res = await fetch(api.jobAudioUrl(job.id, true));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ext = String((job.result as Record<string, unknown> | null)?.format ?? "mp3");
      const safe = title.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || job.id;
      await saveBlob(await res.blob(), `${safe}.${ext}`);
    } catch (e) {
      toast.error(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const running = job.status === "running";
  const duration = resultNumber(job, "duration");
  const err = errorText(job);
  const isCurrent = player.track?.id === job.id;

  const play = () => {
    if (isCurrent) {
      player.toggle();
      return;
    }
    player.load({ id: job.id, title, subtitle: `${kindLabel(job.kind)} · ${relTime(job.created)}`, src: api.jobAudioUrl(job.id), href: `/jobs/${job.id}`, duration });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-4 rounded-xl border px-3 py-3 transition-[background,border,box-shadow]",
        selected ? "surface-raised border-fire/40" : "border-transparent hover:bg-surface/70",
      )}
    >
      <ArtTile seed={job.id} className="size-12 shrink-0">
        {running ? <Equalizer className="text-white" /> : <Icon className="size-5 opacity-90" />}
      </ArtTile>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-ink">{title}</span>
          <Badge tone={statusTone(job.status)} dot={!running}>
            {running && <Equalizer className="h-2.5" />}
            {job.status}
          </Badge>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
          <span>{kindLabel(job.kind)}</span>
          <span aria-hidden>·</span>
          <span>{relTime(job.created)}</span>
          {job.elapsed != null && (
            <>
              <span aria-hidden>·</span>
              <span className="tabular">{fmtDuration(job.elapsed)} elapsed</span>
            </>
          )}
          {duration != null && (
            <>
              <span aria-hidden>·</span>
              <span className="tabular">{fmtDuration(duration)} audio</span>
            </>
          )}
        </div>
        {running && (
          <div className="mt-2 flex items-center gap-3">
            <ProgressBar value={job.progress ?? 0} className="max-w-xs" />
            <span className="truncate text-[12px] text-muted">
              {job.step != null && job.steps != null && <span className="tabular">{job.step}/{job.steps} </span>}
              {job.message}
            </span>
          </div>
        )}
        {err && <p className="mt-1 truncate text-[12px] text-bad">{err}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {hasAudio(job) && (
          <>
            <Tooltip content={isCurrent && player.playing ? "Pause" : "Play"}>
              <Button variant={isCurrent ? "soft" : "ghost"} size="icon-sm" aria-label={isCurrent && player.playing ? "Pause" : `Play ${title}`} onClick={play}>
                {isCurrent && player.playing ? <Equalizer className="h-3 text-fire" /> : <Play className="size-4" />}
              </Button>
            </Tooltip>
            <Tooltip content="Download audio">
              <Button variant="ghost" size="icon-sm" aria-label={`Download ${title}`} onClick={download}>
                <Download className="size-4" />
              </Button>
            </Tooltip>
          </>
        )}
        {!isTerminal(job) && (
          <Tooltip content="Cancel job">
            <Button variant="ghost" size="icon-sm" aria-label={`Cancel ${title}`} onClick={onCancel}>
              <Ban className="size-4" />
            </Button>
          </Tooltip>
        )}
        {isTerminal(job) && (
          <Tooltip content="Delete job">
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${title}`} onClick={onDelete} className="hover:text-bad">
              <Trash2 className="size-4" />
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
