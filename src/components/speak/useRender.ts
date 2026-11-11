import { useCallback, useEffect, useRef } from "react";
import { useSessionState } from "@/stores/session";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { errMessage } from "@/lib/api/hooks";
import type { TTSRequest, WordTime } from "@/lib/api/types";
import { blobFromBase64 } from "@/lib/audio";
import { usePlayer, type Track } from "@/stores/player";
import { useSettings } from "@/stores/settings";
import { uid, truncate } from "@/lib/utils";
import { engineName } from "@/lib/engineNames";

export interface RenderStats {
  duration: number;
  seconds?: number;
  rtf?: number;
  chunks?: number;
  takes?: number;
  retries?: number;
  warnings: string[];
  engine?: string;
  /** the kept render (keep_takes), for the takes and QA panel */
  renderId?: string | null;
}

export type RenderPhase = "idle" | "starting" | "rendering" | "done" | "error";

export interface RenderState {
  phase: RenderPhase;
  stats: RenderStats | null;
  error: string | null;
  words: WordTime[];
  chunksGot: number;
  chunksTotal: number;
  /** when the render started (ms), for the elapsed time while it works */
  startedAt?: number;
}

const idle: RenderState = { phase: "idle", stats: null, error: null, words: [], chunksGot: 0, chunksTotal: 0 };

function trackMeta(req: TTSRequest, engine?: string): Pick<Track, "title" | "subtitle"> {
  const firstLine = req.text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  return {
    title: truncate(firstLine || "Untitled render", 64),
    subtitle: [req.voice === "default" ? "Default voice" : req.voice?.startsWith("design:") ? "Designed voice" : req.voice, req.style, engineName(engine ?? req.engine)]
      .filter(Boolean)
      .join(" · "),
  };
}

// One render at a time, shared by every visit to Speak: leaving the page and coming back finds it as it was
// (still rendering, with its Stop button, or done with its result).
const abortRef: { current: AbortController | null } = { current: null };

/** Renders the whole file (every sentence checked and mastered) and feeds the global player. Speak no longer
 * streams; the API's /api/v1/tts/stream routes stay for programs that want audio as it is made. */
export function useRender() {
  const [state, setState] = useSessionState<RenderState>("speak.render", idle);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((s) => (s.phase === "rendering" || s.phase === "starting" ? { ...s, phase: "idle" } : s));
  }, []);

  // Leaving the page does not cancel a render: it finishes (and is kept in History), playing in the player bar.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const renderWhole = useCallback(async (req: TTSRequest) => {
    stop();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ ...idle, phase: "rendering", startedAt: Date.now() });
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
        stats: { duration: r.duration, seconds: r.seconds, rtf: r.rtf, chunks: r.chunks, takes: r.takes, retries: r.retries, warnings: r.warnings ?? [], engine: r.engine, renderId: r.render_id ?? null },
      });
      if (r.warnings?.length) toast.warning(r.warnings[0], { description: r.warnings.length > 1 ? `${r.warnings.length - 1} more warning(s)` : undefined });
      if (!mounted.current) toast.success("Your render is ready", { description: "It's in the player and saved in History." });
    } catch (e) {
      if (ac.signal.aborted) return;
      const msg = errMessage(e);
      setState({ ...idle, phase: "error", error: msg });
      toast.error(msg);
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, [stop]);

  /** After a take is swapped in a kept render: load the re-stitched audio and its word times. */
  const replaceResult = useCallback((blob: Blob, format: string, words: WordTime[], duration: number) => {
    const p = usePlayer.getState();
    const cur = p.track;
    p.load({ id: uid(), title: cur?.title ?? "Render", subtitle: cur?.subtitle ?? "", src: URL.createObjectURL(blob), blob, format, duration, words, href: "/speak" }, false);
    setState((s) => ({ ...s, words, stats: s.stats ? { ...s.stats, duration } : s.stats }));
  }, []);

  const busy = state.phase === "starting" || state.phase === "rendering";
  return { state, busy, renderWhole, stop, replaceResult };
}
