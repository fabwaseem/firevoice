import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AudioLines, Captions, Copy, Download, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import type { STTResult } from "@/lib/api/types";
import { saveBlob } from "@/lib/audio";
import { cn, fmtDuration, langName } from "@/lib/utils";
import { activeWordIndex, usePlayer } from "@/stores/player";
import { useStudio } from "@/stores/studio";
import { Badge, Button, Card, CardBody, CardHeader, Equalizer, Tooltip } from "@/components/ui";
import type { SourceFile } from "./AudioSource";
import { wordsToSrt } from "./srt";

export function TranscriptResult({ result, source, trackId }: { result: STTResult; source: SourceFile; trackId: string }) {
  const navigate = useNavigate();
  const setStudio = useStudio((s) => s.set);
  const player = usePlayer();
  const isCurrent = player.track?.id === trackId;
  const active = isCurrent ? activeWordIndex(result.words, player.position) : -1;
  const activeRef = useRef<HTMLButtonElement>(null);
  const [srcUrl] = useState(() => URL.createObjectURL(source.blob));
  useEffect(() => () => URL.revokeObjectURL(srcUrl), [srcUrl]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  const speed = result.seconds > 0 ? result.duration / result.seconds : null;
  const base = source.name.replace(/\.[^.]+$/, "") || "transcript";
  const srt = useMemo(() => wordsToSrt(result.words), [result.words]);

  const ensureLoaded = () => {
    if (!isCurrent) {
      player.load({ id: trackId, title: source.name, subtitle: `Transcript · ${langName(result.language)}`, src: srcUrl, blob: source.blob, duration: result.duration, words: result.words, href: "/transcribe" }, false);
    }
  };
  const togglePlay = () => {
    if (isCurrent) player.toggle();
    else player.load({ id: trackId, title: source.name, subtitle: `Transcript · ${langName(result.language)}`, src: srcUrl, blob: source.blob, duration: result.duration, words: result.words, href: "/transcribe" });
  };
  const seekWord = (start: number) => {
    ensureLoaded();
    player.requestSeek(start);
    if (!player.playing) player.setPlaying(true);
  };
  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  };

  return (
    <Card raised className="fade-up">
      <CardHeader
        title="Transcript"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="fire">
              {langName(result.language)} · {Math.round(result.language_probability * 100)}%
            </Badge>
            <span className="tabular">{fmtDuration(result.duration)} audio</span>
            <span aria-hidden>·</span>
            <span className="tabular">{fmtDuration(result.seconds)} processing</span>
            {speed != null && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular">{speed.toFixed(1)}× realtime</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span className="font-mono text-[11.5px]">
              {result.model} on {result.device}
            </span>
          </span>
        }
        action={
          <Button variant="primary" size="sm" onClick={togglePlay} leading={isCurrent && player.playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}>
            {isCurrent && player.playing ? "Pause" : "Play"}
          </Button>
        }
      />
      <CardBody>
        <div className="max-h-[42vh] overflow-y-auto rounded-xl bg-surface-2 px-4 py-3 text-[15px] leading-[1.9] text-ink" aria-label="Transcript words">
          {result.words.length ? (
            result.words.map((w, i) => (
              <span key={i}>
              {w.speaker && w.speaker !== result.words[i - 1]?.speaker && (
                <>{i > 0 && <br />}<span className="mr-1.5 rounded-full bg-fire-soft px-2 py-0.5 text-[12px] font-semibold text-fire">{w.speaker}</span></>
              )}
              <button
                key={i}
                ref={i === active ? activeRef : undefined}
                type="button"
                onClick={() => seekWord(w.start)}
                title={`${w.start.toFixed(2)} s`}
                className={cn(
                  "-mx-px rounded-[5px] px-px transition-colors hover:bg-fire-soft hover:text-fire",
                  i === active && "bg-fire text-white hover:bg-fire hover:text-white",
                )}
              >
                {w.roman ?? w.text}{" "}
              </button>
              </span>
            ))
          ) : (
            <p>{result.text_roman ?? result.text}</p>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" leading={<Copy className="size-4" />} onClick={() => void copy(result.text_roman ?? result.text, "Text")}>
            Copy text
          </Button>
          <Tooltip content="Subtitle cues built from word times" disabled={!srt}>
            <span>
              <Button size="sm" leading={<Captions className="size-4" />} disabled={!srt} onClick={() => void copy(srt, "SRT")}>
                Copy SRT
              </Button>
            </span>
          </Tooltip>
          <Button size="sm" leading={<Download className="size-4" />} onClick={() => void saveBlob(new Blob([result.text], { type: "text/plain" }), `${base}.txt`)}>
            Save .txt
          </Button>
          <Button size="sm" leading={<Download className="size-4" />} disabled={!srt} onClick={() => void saveBlob(new Blob([srt], { type: "text/plain" }), `${base}.srt`)}>
            Save .srt
          </Button>
          <Button
            size="sm"
            variant="soft"
            className="ml-auto"
            leading={<AudioLines className="size-4" />}
            onClick={() => {
              setStudio({ text: result.text });
              navigate("/speak");
            }}
          >
            Send to Speak
          </Button>
        </div>
        {isCurrent && player.playing && (
          <p className="mt-3 flex items-center gap-2 text-[12px] text-muted">
            <Equalizer className="text-fire" /> Following playback; click a word to jump.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
