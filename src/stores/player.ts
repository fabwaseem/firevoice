import { create } from "zustand";
import type { WordTime } from "@/lib/api/types";

export interface Track {
  id: string;
  title: string;
  subtitle?: string;
  /** Object URL or server URL of the audio */
  src: string;
  blob?: Blob;
  format?: string;
  duration?: number;
  words?: WordTime[];
  /** Where to navigate when the player title is clicked */
  href?: string;
  /** Visual accent hue for the artwork tile */
  hue?: number;
}

interface PlayerState {
  track: Track | null;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  /** Streaming mode: the audio element is bypassed and a ChunkPlayer drives position */
  live: boolean;
  /** Streaming progress: chunks received of total */
  liveChunks: { got: number; total: number } | null;
  queue: Track[];
  load: (t: Track, autoplay?: boolean) => void;
  setPlaying: (v: boolean) => void;
  toggle: () => void;
  setPosition: (v: number) => void;
  setDuration: (v: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  setLive: (live: boolean, chunks?: { got: number; total: number } | null) => void;
  /** Request a seek; the bound <audio> element listens for this */
  seekTo: number | null;
  requestSeek: (v: number) => void;
  clear: () => void;
}

export const usePlayer = create<PlayerState>()((set, get) => ({
  track: null,
  playing: false,
  position: 0,
  duration: 0,
  volume: 0.9,
  muted: false,
  live: false,
  liveChunks: null,
  queue: [],
  seekTo: null,
  load: (track, autoplay = true) => {
    const prev = get().track;
    if (prev?.src.startsWith("blob:") && prev.src !== track.src && prev.id !== track.id) URL.revokeObjectURL(prev.src);
    set({ track, playing: autoplay, position: 0, duration: track.duration ?? 0, live: false, liveChunks: null, seekTo: null });
  },
  setPlaying: (playing) => set({ playing }),
  toggle: () => set((s) => ({ playing: !s.playing })),
  setPosition: (position) => set({ position }),
  setDuration: (duration) => set({ duration }),
  setVolume: (volume) => set({ volume, muted: false }),
  toggleMute: () => set((s) => ({ muted: !s.muted })),
  setLive: (live, liveChunks = null) => set({ live, liveChunks }),
  requestSeek: (seekTo) => set({ seekTo, position: seekTo }),
  clear: () => {
    const prev = get().track;
    if (prev?.src.startsWith("blob:")) URL.revokeObjectURL(prev.src);
    set({ track: null, playing: false, position: 0, duration: 0, live: false, liveChunks: null });
  },
}));

/** Index of the word under the playhead, or -1. */
export function activeWordIndex(words: WordTime[] | undefined, pos: number): number {
  if (!words?.length) return -1;
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid];
    if (pos < w.start) hi = mid - 1;
    else if (pos > w.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}
