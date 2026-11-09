import { useEffect, useRef, useState } from "react";
import { Mic, Square, Trash2 } from "lucide-react";
import { Recorder } from "@/lib/audio";
import { cn, fmtTime } from "@/lib/utils";
import { Button } from "@/components/ui";

/** Microphone recorder with a live level meter and playback preview. Emits the recorded blob. */
export function RecordPanel({ value, onChange }: { value: Blob | null; onChange: (b: Blob | null) => void }) {
  const rec = useRef<Recorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!value) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(value);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    let raf = 0;
    const tick = () => {
      setLevel(rec.current?.level() ?? 0);
      setElapsed((Date.now() - started) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recording]);

  useEffect(() => () => void (rec.current?.active && rec.current.stop()), []);

  const start = async () => {
    setError(null);
    try {
      rec.current = new Recorder();
      await rec.current.start();
      setRecording(true);
      onChange(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Microphone access failed");
    }
  };

  const stop = async () => {
    const blob = await rec.current!.stop();
    setRecording(false);
    setLevel(0);
    onChange(blob.size ? blob : null);
  };

  const bars = 24;
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-4">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={recording ? stop : start}
          aria-label={recording ? "Stop recording" : "Start recording"}
          className={cn(
            "flex size-14 shrink-0 items-center justify-center rounded-full text-white shadow-md transition-transform hover:scale-105 active:scale-95",
            recording ? "bg-bad" : "fire-gradient",
          )}
        >
          {recording ? <Square className="size-5 fill-current" /> : <Mic className="size-6" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex h-10 items-center gap-[3px]" aria-hidden>
            {Array.from({ length: bars }).map((_, i) => {
              const falloff = 1 - Math.abs(i - bars / 2) / (bars / 2);
              const h = recording ? 0.15 + Math.min(1, level * 6) * falloff * (0.6 + 0.4 * Math.sin(i * 1.7 + elapsed * 8)) : 0.15;
              return <span key={i} className={cn("w-[4px] flex-1 rounded-full transition-[height] duration-75", recording ? "bg-fire" : "bg-surface-3")} style={{ height: `${Math.round(h * 100)}%` }} />;
            })}
          </div>
          <p className="mt-1 text-[12.5px] text-muted tabular" role="status">
            {recording ? `Recording ${fmtTime(elapsed)} — read 7 to 14 seconds of natural speech` : value ? "Recording ready" : "Press to record a 7 to 14 second clip in a quiet room"}
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-[12.5px] text-bad">
          {error}
        </p>
      )}

      {previewUrl && !recording && (
        <div className="mt-3 flex items-center gap-2">
          <audio controls src={previewUrl} className="h-9 min-w-0 flex-1" />
          <Button variant="ghost" size="icon-sm" aria-label="Discard recording" onClick={() => onChange(null)}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
