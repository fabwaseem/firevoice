import { useState, type ComponentType } from "react";
import { AudioLines, Download, FileText, History, Layers, Mic, MessagesSquare, Music, Pause, Play, Repeat2, Sparkles, Trash2, Waves } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { errMessage, useDeleteHistory, useHistory } from "@/lib/api/hooks";
import type { HistoryItem, HistoryKind } from "@/lib/api/types";
import { engineName } from "@/lib/engineNames";
import { saveBlob } from "@/lib/audio";
import { cn, fmtTime, relTime } from "@/lib/utils";
import { usePlayer } from "@/stores/player";
import { Button, ConfirmDialog, EmptyState, Skeleton, Tooltip } from "@/components/ui";

type Icon = ComponentType<{ className?: string }>;

export const KIND: Record<HistoryKind, { label: string; icon: Icon; tint: string }> = {
  speech: { label: "Speech", icon: AudioLines, tint: "text-fire bg-fire-soft" },
  sound: { label: "Sound effect", icon: Waves, tint: "text-info bg-info-soft" },
  music: { label: "Music", icon: Music, tint: "text-[#a78bfa] bg-[rgba(167,139,250,0.14)]" },
  changer: { label: "Voice changer", icon: Repeat2, tint: "text-ok bg-ok-soft" },
  dialogue: { label: "Dialogue", icon: MessagesSquare, tint: "text-warn bg-warn-soft" },
  transcript: { label: "Transcript", icon: Mic, tint: "text-ink-2 bg-surface-3" },
  separate: { label: "Separated", icon: Layers, tint: "text-info bg-info-soft" },
  clean: { label: "Cleaned", icon: Sparkles, tint: "text-ok bg-ok-soft" },
};

/** The audio files of an item worth playing, with a label each (a separation has two, a dialogue its mix). */
function tracks(item: HistoryItem): { stem: string; label: string }[] {
  if (item.kind === "separate") {
    const rest = item.meta.mode === "denoise" ? "Noise" : item.meta.mode === "dereverb" ? "Room echo" : "Music";
    return [{ stem: "voice", label: "Voice" }, { stem: "rest", label: rest }];
  }
  if (item.kind === "dialogue") return [{ stem: "mix", label: "Mix" }];
  return item.files.audio ? [{ stem: "audio", label: "Play" }] : [];
}

function subtitle(item: HistoryItem): string {
  const m = item.meta ?? {};
  const bits: string[] = [KIND[item.kind]?.label ?? item.kind];
  if (item.kind === "speech") {
    if (m.engine) bits.push(engineName(String(m.engine)));
  } else if (item.kind === "changer" && m.voice_name) bits.push(`as ${m.voice_name}`);
  else if (item.kind === "dialogue" && Array.isArray(m.speakers)) bits.push(`${m.speakers.length} speakers`);
  else if (item.kind === "transcript" && typeof m.words === "number") bits.push(`${m.words} words`);
  if (item.duration) bits.push(fmtTime(item.duration));
  bits.push(relTime(item.created));
  return bits.join(" · ");
}

function safeName(s: string) {
  return (s || "firevoice").replace(/[^\w\- ]+/g, "").trim().slice(0, 60).replace(/\s+/g, "-") || "firevoice";
}

export function HistoryRow({ item, compact }: { item: HistoryItem; compact?: boolean }) {
  const playingId = usePlayer((s) => (s.playing ? s.track?.id : null));
  const load = usePlayer((s) => s.load);
  const toggle = usePlayer((s) => s.toggle);
  const remove = useDeleteHistory();
  const [confirm, setConfirm] = useState(false);
  const k = KIND[item.kind] ?? KIND.sound;
  const Icon = k.icon;

  const play = (stem: string, label: string) => {
    const id = `history:${item.id}:${stem}`;
    if (usePlayer.getState().track?.id === id) return toggle();
    load({ id, title: item.title, subtitle: stem === "audio" ? k.label : `${k.label} · ${label}`, src: api.historyAudioUrl(item, stem), duration: item.duration ?? undefined, href: "/history" });
  };
  const download = async (stem: string, format = "mp3") => {
    try {
      const blob = await api.historyFile(item, stem, format);
      await saveBlob(blob, `${safeName(item.title)}${stem !== "audio" ? "-" + stem : ""}.${format}`);
    } catch (e) {
      toast.error(errMessage(e));
    }
  };
  const downloadText = async (file: string) => {
    try {
      const blob = await api.historyFile(item, file);
      await saveBlob(blob, `${safeName(item.title)}.${file.split(".").pop()}`);
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  return (
    <div className={cn("group flex items-center gap-3 rounded-xl px-3 transition-colors hover:bg-surface-2", compact ? "py-2" : "py-2.5")}>
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-[10px]", k.tint)}>
        <Icon className="size-[17px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium text-ink" title={item.title}>{item.title}</p>
        <p className="truncate text-[12px] text-muted">{subtitle(item)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {tracks(item).map((t) => {
          const on = playingId === `history:${item.id}:${t.stem}`;
          return (
            <Button key={t.stem} size="sm" variant={on ? "soft" : "ghost"} leading={on ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={() => play(t.stem, t.label)}>
              {t.stem === "audio" ? (on ? "Pause" : "Play") : t.label}
            </Button>
          );
        })}
        {item.kind === "transcript" && (
          <>
            <Tooltip content="Download text">
              <Button size="icon-sm" variant="ghost" aria-label="Download text" onClick={() => void downloadText("transcript.txt")}>
                <FileText className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content="Download subtitles (SRT)">
              <Button size="sm" variant="ghost" onClick={() => void downloadText("transcript.srt")}>SRT</Button>
            </Tooltip>
          </>
        )}
        {tracks(item).length > 0 && (
          <Tooltip content="Download">
            <Button size="icon-sm" variant="ghost" aria-label="Download" onClick={() => void download(tracks(item)[0].stem)}>
              <Download className="size-4" />
            </Button>
          </Tooltip>
        )}
        <Tooltip content="Delete">
          <Button size="icon-sm" variant="ghost" aria-label="Delete" className="text-muted hover:text-bad" onClick={() => setConfirm(true)}>
            <Trash2 className="size-4" />
          </Button>
        </Tooltip>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this from History?"
        description={`“${item.title}” and its files are removed from this computer. This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate(item, { onSuccess: () => setConfirm(false) })}
      />
    </div>
  );
}

/** The newest saved outputs of some kinds, for the page that makes them (Sound, Voice changer, Dialogue...). */
export function RecentHistory({ kinds, title = "Recent", limit = 8, empty }: { kinds: HistoryKind[]; title?: string; limit?: number; empty?: string }) {
  const q = useHistory(kinds, { limit });
  const items = q.data ?? [];
  return (
    <section className="mt-5">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        <a href="#/history" className="text-[12.5px] font-medium text-fire hover:underline">All history</a>
      </div>
      <div className="surface rounded-xl p-1.5">
        {q.isLoading ? (
          <div className="space-y-1.5 p-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-11 rounded-lg" />)}</div>
        ) : items.length === 0 ? (
          <EmptyState className="py-8" icon={<History />} title="Nothing yet" description={empty ?? "What you make here is saved automatically and shows up here."} />
        ) : (
          <div className="divide-y divide-line/60">{items.map((it) => <HistoryRow key={it.id} item={it} compact />)}</div>
        )}
      </div>
    </section>
  );
}
