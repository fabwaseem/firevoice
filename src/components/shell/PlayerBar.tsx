import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { Download, Pause, Play, Radio, RotateCcw, RotateCw, Volume1, Volume2, VolumeX, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { usePlayer } from "@/stores/player";
import { cn, fmtTime } from "@/lib/utils";
import { saveBlob } from "@/lib/audio";
import { ArtTile, Button, Equalizer, Slider, Tooltip } from "@/components/ui";

/** Skip by `d` seconds within the current file (not while streaming). */
function skip(d: number) {
  const p = usePlayer.getState();
  if (p.live || !p.track) return;
  p.requestSeek(Math.max(0, Math.min(p.duration || 0, p.position + d)));
}

/** Elements where the keyboard belongs to the control, not to the player shortcuts. */
const TYPING = "input,textarea,select,[contenteditable],[contenteditable=''],[role=slider],[role=textbox],[role=listbox],[role=option],[role=menu],[role=menuitem],[role=tab],[role=radio],[role=combobox]";

/** Persistent bottom player. Owns the <audio> element for file playback; live streams drive the store directly. */
export function PlayerBar() {
  // Everything except the playhead: the position changes several times a second and only <Progress> needs it.
  const p = usePlayer(
    useShallow((s) => ({ track: s.track, playing: s.playing, live: s.live, volume: s.volume, muted: s.muted, seekTo: s.seekTo })),
  );
  const audioRef = useRef<HTMLAudioElement>(null);
  const navigate = useNavigate();
  const hasTrack = !!p.track;

  // Bind the store to the element.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || p.live) return;
    if (p.playing) void a.play().catch(() => usePlayer.getState().setPlaying(false));
    else a.pause();
  }, [p.playing, p.track?.src, p.live]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = p.muted ? 0 : p.volume;
  }, [p.volume, p.muted]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a || p.seekTo == null || p.live) return;
    a.currentTime = p.seekTo;
    usePlayer.setState({ seekTo: null });
  }, [p.seekTo, p.live]);

  // Global shortcuts when focus isn't in a field: Space plays or pauses, ←/→ skip 5 seconds.
  useEffect(() => {
    if (!hasTrack) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(TYPING)) return;
      if (e.code === "Space") {
        if (t?.closest?.("button,a")) return;
        e.preventDefault();
        usePlayer.getState().toggle();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        skip(e.key === "ArrowLeft" ? -5 : 5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasTrack]);

  const track = p.track;
  const VolIcon = p.muted || p.volume === 0 ? VolumeX : p.volume < 0.5 ? Volume1 : Volume2;
  const actions = usePlayer.getState();

  return (
    <>
      <audio
        ref={audioRef}
        src={!p.live ? track?.src : undefined}
        preload="auto"
        onTimeUpdate={(e) => !usePlayer.getState().live && actions.setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => !usePlayer.getState().live && Number.isFinite(e.currentTarget.duration) && actions.setDuration(e.currentTarget.duration)}
        onEnded={() => actions.setPlaying(false)}
        onPlay={() => actions.setPlaying(true)}
        onPause={() => actions.setPlaying(false)}
      />
      <AnimatePresence>
        {track && (
          <motion.div
            key="player"
            // slide only: an ancestor that fades (opacity) cuts the bar's backdrop blur off from the page behind it
            initial={{ y: 120 }}
            animate={{ y: 0 }}
            exit={{ y: 120 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-4 pb-4"
          >
            <div className="player-glass pointer-events-auto mx-auto flex h-[76px] max-w-[1400px] items-center gap-4 rounded-2xl px-4 shadow-lg">
              {/* Now playing */}
              <button
                type="button"
                onClick={() => track.href && navigate(track.href)}
                className="flex min-w-0 w-[260px] items-center gap-3 rounded-lg text-left"
                title={track.title}
              >
                <ArtTile seed={track.id} className="size-12 shrink-0">
                  {p.playing ? <Equalizer className="text-white" /> : <Radio className="size-5 opacity-90" />}
                </ArtTile>
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-semibold text-ink">{track.title}</span>
                  <span className="block truncate text-[12px] text-muted">{track.subtitle}</span>
                </span>
              </button>

              {/* Transport */}
              <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <div className="flex items-center gap-1">
                  <Tooltip content="Back 5 s" shortcut="←">
                    <Button variant="ghost" size="icon-sm" onClick={() => skip(-5)} disabled={p.live} aria-label="Back 5 seconds">
                      <RotateCcw className="size-4" />
                    </Button>
                  </Tooltip>
                  <Tooltip content={p.playing ? "Pause" : "Play"} shortcut="Space">
                    <button
                      type="button"
                      onClick={actions.toggle}
                      disabled={p.live && !p.playing}
                      aria-label={p.playing ? "Pause" : "Play"}
                      className="fire-gradient mx-1 flex size-10 items-center justify-center rounded-full text-white shadow-[0_6px_18px_-6px_rgba(255,90,45,0.6)] transition-transform hover:scale-105 active:scale-95 disabled:opacity-60"
                    >
                      {p.playing ? <Pause className="size-[18px] fill-current" /> : <Play className="ml-0.5 size-[18px] fill-current" />}
                    </button>
                  </Tooltip>
                  <Tooltip content="Forward 5 s" shortcut="→">
                    <Button variant="ghost" size="icon-sm" onClick={() => skip(5)} disabled={p.live} aria-label="Forward 5 seconds">
                      <RotateCw className="size-4" />
                    </Button>
                  </Tooltip>
                </div>
                <Progress />
              </div>

              {/* Right controls */}
              <div className="flex w-[260px] items-center justify-end gap-1">
                <div className="group/vol flex items-center gap-2">
                  <Button variant="ghost" size="icon-sm" onClick={actions.toggleMute} aria-label={p.muted ? "Unmute" : "Mute"}>
                    <VolIcon className="size-4" />
                  </Button>
                  <Slider value={p.muted ? 0 : p.volume} onChange={actions.setVolume} max={1} step={0.02} ariaLabel="Volume" className="w-24" accent={false} />
                </div>
                {track.blob && (
                  <Tooltip content="Save audio">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Save audio"
                      onClick={() => void saveBlob(track.blob!, `${track.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 48) || "firevoice"}.${track.format ?? "mp3"}`)}
                    >
                      <Download className="size-4" />
                    </Button>
                  </Tooltip>
                )}
                <Tooltip content="Close player">
                  <Button variant="ghost" size="icon-sm" onClick={actions.clear} aria-label="Close player">
                    <X className="size-4" />
                  </Button>
                </Tooltip>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** The seek bar and times: the only part of the player that re-renders as the playhead moves. */
function Progress() {
  const { position, duration, live, liveChunks } = usePlayer(
    useShallow((s) => ({ position: s.position, duration: s.duration, live: s.live, liveChunks: s.liveChunks })),
  );
  return (
    <div className="flex w-full max-w-[640px] items-center gap-3">
      <span className="w-10 text-right text-[11.5px] text-muted tabular">{fmtTime(position)}</span>
      <div className="relative flex-1">
        <Slider
          value={Math.min(position, duration || 0)}
          max={Math.max(duration, 0.01)}
          step={0.05}
          onChange={(v) => !usePlayer.getState().live && usePlayer.getState().requestSeek(v)}
          ariaLabel="Seek"
          disabled={live}
          className="h-4"
        />
        {live && liveChunks && (
          <div className="pointer-events-none absolute inset-x-0 -bottom-2 flex gap-[2px]" aria-hidden>
            {Array.from({ length: liveChunks.total }).map((_, i) => (
              <span key={i} className={cn("h-[3px] flex-1 rounded-full", i < liveChunks.got ? "bg-ok" : "bg-surface-3")} />
            ))}
          </div>
        )}
      </div>
      <span className="w-10 text-[11.5px] text-muted tabular">{live && !duration ? "Live" : fmtTime(duration)}</span>
    </div>
  );
}
