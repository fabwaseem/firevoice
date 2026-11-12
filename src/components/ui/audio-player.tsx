import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Download, Pause, Play, Volume2, VolumeX } from "@/components/icons";
import { authHeaders } from "@/lib/api/client";
import { usePlayer } from "@/stores/player";
import { cn, fmtTime } from "@/lib/utils";

/* ---------------------------------------------------------------------------------------------------------------
 * Waveform peaks: decoded once per source and cached, so a player that remounts (page change) draws instantly.
 * ------------------------------------------------------------------------------------------------------------- */

const PEAKS = 600;
type Wave = { peaks: number[]; duration: number };
const waves = new Map<string, Promise<Wave | null>>();
let ctx: AudioContext | null = null;

function loadWave(src: string): Promise<Wave | null> {
  let p = waves.get(src);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(src, { headers: src.startsWith("blob:") || src.startsWith("data:") ? {} : authHeaders() });
        if (!r.ok) return null;
        const buf = await r.arrayBuffer();
        ctx ??= new AudioContext();
        const audio = await ctx.decodeAudioData(buf);
        const chans = Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, i) => audio.getChannelData(i));
        const len = chans[0].length;
        const per = Math.max(1, Math.floor(len / PEAKS));
        const peaks: number[] = [];
        for (let b = 0; b < PEAKS; b++) {
          let m = 0;
          const end = Math.min(len, (b + 1) * per);
          // a stride keeps long files (minutes of music) quick without losing the shape
          for (let i = b * per; i < end; i += 4) for (const c of chans) m = Math.max(m, Math.abs(c[i]));
          peaks.push(m);
        }
        const top = Math.max(...peaks, 1e-4);
        return { peaks: peaks.map((v) => Math.pow(v / top, 0.8)), duration: audio.duration };
      } catch {
        return null;
      }
    })();
    waves.set(src, p);
    // object URLs are short-lived; forget their waveform once the cache grows
    if (waves.size > 40) waves.delete(waves.keys().next().value!);
  }
  return p;
}

/** A gentle stand-in shape while the real waveform decodes (stable per source, so it does not flicker). */
function placeholder(src: string, n: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 16777619);
  return Array.from({ length: n }, (_, i) => {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return 0.25 + 0.35 * Math.abs(Math.sin(i / 3.1)) + 0.2 * (((h >>> 0) % 100) / 100);
  });
}

/** Resample peaks to `n` bars (max over each bar's span). */
function bars(peaks: number[], n: number): number[] {
  if (n <= 0) return [];
  return Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * peaks.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / n));
    let m = 0;
    for (let j = a; j < b; j++) m = Math.max(m, peaks[j] ?? 0);
    return m;
  });
}

/* ---------------------------------------------------------------------------------------------------------------
 * One inline player plays at a time, and never over the bottom player bar.
 * ------------------------------------------------------------------------------------------------------------- */

let current: HTMLAudioElement | null = null;
function claim(a: HTMLAudioElement) {
  if (current && current !== a) current.pause();
  current = a;
  if (usePlayer.getState().playing) usePlayer.getState().setPlaying(false);
}

const RATES = [1, 1.25, 1.5, 2, 0.75];
/** Sources that already auto-played: coming back to a page shows its result without playing it again. */
const autoPlayed = new Set<string>();

export interface AudioPlayerProps {
  src: string;
  autoPlay?: boolean;
  /** Called as the playhead moves (seconds). */
  onTimeUpdate?: (t: number) => void;
  onEnded?: () => void;
  /** Show a save button that calls this. */
  onDownload?: () => void;
  /** Smaller height for tight spots (a recording preview row). */
  size?: "sm" | "md";
  className?: string;
  label?: string;
}

/** FireVoice's inline audio player: play button, a waveform you can click or drag to seek, times, speed, mute and an
 * optional save button. The underlying <audio> element is exposed through `ref` (for code that seeks or follows the
 * playhead). */
export const AudioPlayer = forwardRef<HTMLAudioElement | null, AudioPlayerProps>(function AudioPlayer(
  { src, autoPlay, onTimeUpdate, onEnded, onDownload, size = "md", className, label = "Audio" },
  ref,
) {
  const audio = useRef<HTMLAudioElement>(null);
  useImperativeHandle(ref, () => audio.current as HTMLAudioElement, []);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [wave, setWave] = useState<Wave | null | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);
  const h = size === "sm" ? 28 : 40;
  // decided once per source (a new result in the same spot still auto-plays)
  const auto = useMemo(() => {
    const yes = !!autoPlay && !autoPlayed.has(src);
    if (yes) autoPlayed.add(src);
    return yes;
  }, [src, autoPlay]);

  // waveform for this source
  useEffect(() => {
    let live = true;
    setWave(undefined);
    setT(0);
    setDur(0);
    void loadWave(src).then((w) => live && setWave(w));
    return () => {
      live = false;
    };
  }, [src]);

  // bar count follows the width
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the bottom player bar taking over pauses this one
  useEffect(
    () =>
      usePlayer.subscribe((s, prev) => {
        if (s.playing && !prev.playing) audio.current?.pause();
      }),
    [],
  );

  // a smooth playhead while playing (timeupdate alone fires only about 4 times a second)
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      const a = audio.current;
      if (a && !dragging.current) setT(a.currentTime);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing]);

  useEffect(() => () => { if (current === audio.current) current = null; }, []);

  const duration = Number.isFinite(dur) && dur > 0 ? dur : (wave?.duration ?? 0);
  const frac = duration > 0 ? Math.min(1, t / duration) : 0;

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) {
      claim(a);
      void a.play().catch(() => setPlaying(false));
    } else a.pause();
  };

  const seekTo = useCallback(
    (sec: number) => {
      const a = audio.current;
      if (!a || !(duration > 0)) return;
      const v = Math.max(0, Math.min(duration - 0.01, sec));
      a.currentTime = v;
      setT(v);
    },
    [duration],
  );

  const fracAt = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!(duration > 0)) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(fracAt(e) * duration);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const f = fracAt(e);
    setHover(f);
    if (dragging.current) seekTo(f * duration);
  };
  const up = () => {
    dragging.current = false;
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      seekTo(t + (e.key === "ArrowLeft" ? -5 : 5));
    } else if (e.key === "Home") {
      e.preventDefault();
      seekTo(0);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle();
    }
  };

  const bw = size === "sm" ? 2 : 3;
  const gap = 2;
  const n = width > 0 ? Math.max(8, Math.floor((width + gap) / (bw + gap))) : 0;
  const shape = bars(wave?.peaks ?? placeholder(src, 120), n);
  const loading = wave === undefined;

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-xl border border-line bg-surface-2 pr-2",
        size === "sm" ? "py-1 pl-1" : "py-1.5 pl-1.5",
        className,
      )}
    >
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        autoPlay={auto}
        className="hidden"
        onPlay={(e) => {
          claim(e.currentTarget);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          onEnded?.();
        }}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onDurationChange={(e) => setDur(e.currentTarget.duration)}
        onTimeUpdate={(e) => {
          if (!dragging.current) setT(e.currentTarget.currentTime);
          onTimeUpdate?.(e.currentTarget.currentTime);
        }}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
        className={cn(
          "fire-gradient flex shrink-0 items-center justify-center rounded-full text-white shadow-[0_4px_14px_-6px_rgba(255,90,45,0.7)] transition-transform hover:scale-105 active:scale-95",
          size === "sm" ? "size-7" : "size-9",
        )}
      >
        {playing ? <Pause className={cn("fill-current", size === "sm" ? "size-3" : "size-3.5")} /> : <Play className={cn("ml-0.5 fill-current", size === "sm" ? "size-3" : "size-3.5")} />}
      </button>

      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label={`${label}: seek`}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(t)}
        aria-valuetext={`${fmtTime(t)} of ${fmtTime(duration)}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => setHover(null)}
        onKeyDown={key}
        className="group/wave relative min-w-0 flex-1 cursor-pointer touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-fire/40"
        style={{ height: h }}
      >
        {width > 0 && (
          <svg width={width} height={h} className={cn("block", loading && "animate-pulse")} aria-hidden>
            {shape.map((v, i) => {
              const bh = Math.max(2, Math.round(v * (h - 4)));
              const x = i * (bw + gap);
              const played = (i + 0.5) / shape.length <= frac;
              const hovered = hover != null && (i + 0.5) / shape.length <= hover;
              return (
                <rect
                  key={i}
                  x={x}
                  y={(h - bh) / 2}
                  width={bw}
                  height={bh}
                  rx={bw / 2}
                  className={played ? "fill-fire" : hovered ? "fill-fire/45" : "fill-line-strong"}
                />
              );
            })}
          </svg>
        )}
        {hover != null && duration > 0 && (
          <span
            className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded-md bg-ink px-1.5 py-0.5 text-[10.5px] font-medium text-surface tabular shadow"
            style={{ left: `${hover * 100}%` }}
          >
            {fmtTime(hover * duration)}
          </span>
        )}
      </div>

      <span className="shrink-0 text-[11.5px] text-muted tabular">
        {fmtTime(t)}
        <span className="text-faint"> / {fmtTime(duration)}</span>
      </span>
      {size === "md" && (
        <button
          type="button"
          onClick={() => {
            const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
            setRate(next);
            if (audio.current) audio.current.playbackRate = next;
          }}
          title="Playback speed"
          aria-label={`Playback speed ${rate}×`}
          className="h-7 min-w-9 shrink-0 rounded-md px-1.5 text-[11.5px] font-semibold text-muted tabular transition-colors hover:bg-surface-3 hover:text-ink"
        >
          {rate}×
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          const m = !muted;
          setMuted(m);
          if (audio.current) audio.current.muted = m;
        }}
        aria-label={muted ? "Unmute" : "Mute"}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-3 hover:text-ink"
      >
        {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>
      {onDownload && (
        <button
          type="button"
          onClick={onDownload}
          aria-label="Save audio"
          title="Save audio"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <Download className="size-4" />
        </button>
      )}
    </div>
  );
});
