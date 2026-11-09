import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { errMessage } from "@/lib/api/hooks";
import type { StreamChunk, TTSRequest, WordTime } from "@/lib/api/types";
import { audioContext, base64ToBytes, blobFromBase64, ChunkPlayer, chunksToWav } from "@/lib/audio";
import { usePlayer, type Track } from "@/stores/player";
import { useSettings } from "@/stores/settings";
import { uid, truncate } from "@/lib/utils";

export interface RenderStats {
  duration: number;
  seconds?: number;
  rtf?: number;
  chunks?: number;
  takes?: number;
  retries?: number;
  warnings: string[];
  engine?: string;
}

export type RenderPhase = "idle" | "starting" | "streaming" | "rendering" | "done" | "error";

export interface RenderState {
  phase: RenderPhase;
  stats: RenderStats | null;
  error: string | null;
  words: WordTime[];
  chunksGot: number;
  chunksTotal: number;
}

const idle: RenderState = { phase: "idle", stats: null, error: null, words: [], chunksGot: 0, chunksTotal: 0 };

function trackMeta(req: TTSRequest, engine?: string): Pick<Track, "title" | "subtitle"> {
  const firstLine = req.text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  return {
    title: truncate(firstLine || "Untitled render", 64),
    subtitle: [req.voice === "default" ? "Default voice" : req.voice?.startsWith("design:") ? "Designed voice" : req.voice, req.style, engine ?? req.engine]
      .filter(Boolean)
      .join(" · "),
  };
}

/** Orchestrates whole-file and streamed renders and feeds the global player. */
export function useRender() {
  const [state, setState] = useState<RenderState>(idle);
  const abortRef = useRef<AbortController | null>(null);
  const chunkPlayerRef = useRef<ChunkPlayer | null>(null);

  // Live mode: pause/resume by suspending the AudioContext; follow volume.
  useEffect(() => {
    const unsub = usePlayer.subscribe((s, prev) => {
      const cp = chunkPlayerRef.current;
      if (!cp || !s.live) return;
      if (s.playing !== prev.playing) {
        const ctx = audioContext();
        if (s.playing) void ctx.resume();
        else void ctx.suspend();
      }
      if (s.volume !== prev.volume || s.muted !== prev.muted) cp.setVolume(s.muted ? 0 : s.volume);
    });
    return unsub;
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    chunkPlayerRef.current?.stop();
    chunkPlayerRef.current = null;
    void audioContext().resume();
    const p = usePlayer.getState();
    if (p.live) {
      p.setLive(false);
      p.setPlaying(false);
    }
    setState((s) => (s.phase === "streaming" || s.phase === "rendering" || s.phase === "starting" ? { ...s, phase: "idle" } : s));
  }, []);

  useEffect(() => () => stop(), [stop]);

  const renderWhole = useCallback(async (req: TTSRequest) => {
    stop();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ ...idle, phase: "rendering" });
    const { autoPlay } = useSettings.getState();
    try {
      const r = await api.ttsJson(req, ac.signal);
      const blob = blobFromBase64(r.audio_base64, r.format);
      const track: Track = {
        id: uid(),
        ...trackMeta(req, r.engine),
        src: URL.createObjectURL(blob),
        blob,
        format: r.format,
        duration: r.duration,
        words: r.words,
        href: "/speak",
      };
      usePlayer.getState().load(track, autoPlay);
      setState({
        phase: "done",
        error: null,
        words: r.words,
        chunksGot: r.chunks,
        chunksTotal: r.chunks,
        stats: { duration: r.duration, seconds: r.seconds, rtf: r.rtf, chunks: r.chunks, takes: r.takes, retries: r.retries, warnings: r.warnings ?? [], engine: r.engine },
      });
      if (r.warnings?.length) toast.warning(r.warnings[0], { description: r.warnings.length > 1 ? `${r.warnings.length - 1} more warning(s)` : undefined });
    } catch (e) {
      if (ac.signal.aborted) return;
      const msg = errMessage(e);
      setState({ ...idle, phase: "error", error: msg });
      toast.error(msg);
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, [stop]);

  const renderStream = useCallback(async (req: TTSRequest) => {
    stop();
    const ac = new AbortController();
    abortRef.current = ac;
    const player = usePlayer.getState();
    const { muted, volume } = player;
    const cp = new ChunkPlayer(muted ? 0 : volume);
    chunkPlayerRef.current = cp;
    const id = uid();
    const meta = trackMeta(req);
    const collected: { bytes: Uint8Array; start: number }[] = [];
    const words: WordTime[] = [];
    setState({ ...idle, phase: "starting" });

    player.load({ id, ...meta, src: "", href: "/speak" }, true);
    player.setLive(true, { got: 0, total: 0 });
    cp.onProgress = (pos) => {
      const s = usePlayer.getState();
      if (s.live) {
        s.setPosition(pos);
        if (cp.duration !== s.duration) s.setDuration(cp.duration);
      }
    };

    const finalise = async (stats: RenderStats | null) => {
      const wav = await chunksToWav(collected);
      const s = usePlayer.getState();
      if (!wav) {
        s.setLive(false);
        s.clear();
        return;
      }
      s.setLive(false);
      s.load({ id, ...meta, src: URL.createObjectURL(wav.blob), blob: wav.blob, format: "wav", duration: wav.duration, words, href: "/speak" }, false);
      setState((st) => ({ ...st, phase: "done", words, stats: stats ?? { duration: wav.duration, warnings: [], chunks: collected.length } }));
    };

    let doneStats: RenderStats | null = null;
    cp.onEnded = () => {
      chunkPlayerRef.current = null;
      void finalise(doneStats);
    };

    try {
      for await (const ev of api.ttsStream({ ...req, format: "wav" }, ac.signal)) {
        if (ev.type === "chunk") {
          const c = ev as StreamChunk;
          const bytes = base64ToBytes(c.audio_base64);
          collected.push({ bytes, start: c.start });
          words.push(...c.words);
          await cp.push(bytes, c.start);
          const got = collected.length;
          const total = Math.max(c.total ?? 0, got);
          if (usePlayer.getState().live) usePlayer.getState().setLive(true, { got, total });
          setState((s) => ({ ...s, phase: "streaming", chunksGot: got, chunksTotal: total, words: [...words] }));
        } else if (ev.type === "done") {
          const d = ev as Record<string, unknown>;
          doneStats = {
            duration: Number(d.duration ?? cp.duration),
            seconds: d.seconds as number | undefined,
            rtf: d.rtf as number | undefined,
            chunks: collected.length,
            takes: d.takes as number | undefined,
            retries: d.retries as number | undefined,
            warnings: (d.warnings as string[]) ?? [],
            engine: d.engine as string | undefined,
          };
          cp.finish();
          setState((s) => ({ ...s, stats: doneStats }));
          if (doneStats.warnings.length) toast.warning(doneStats.warnings[0]);
        } else if (ev.type === "error") {
          throw new Error(String((ev as { message?: string }).message ?? "render failed"));
        }
      }
      if (!collected.length) {
        cp.stop();
        chunkPlayerRef.current = null;
        usePlayer.getState().setLive(false);
        usePlayer.getState().clear();
        setState({ ...idle, phase: "error", error: "The server sent no audio." });
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      const msg = errMessage(e);
      cp.stop();
      chunkPlayerRef.current = null;
      usePlayer.getState().setLive(false);
      if (collected.length) void finalise(null);
      else usePlayer.getState().clear();
      setState((s) => ({ ...s, phase: "error", error: msg }));
      toast.error(msg);
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, [stop]);

  const busy = state.phase === "starting" || state.phase === "streaming" || state.phase === "rendering";
  return { state, busy, renderWhole, renderStream, stop };
}
