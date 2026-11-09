import { useEffect, useRef, useState, type DragEvent } from "react";
import { FileAudio, Mic, Square, Upload, X } from "lucide-react";
import { Recorder } from "@/lib/audio";
import { cn, fmtBytes, fmtTime } from "@/lib/utils";
import { Button, Segmented } from "@/components/ui";

export interface SourceFile {
  blob: Blob;
  name: string;
  duration: number | null;
}

type Mode = "upload" | "record";

export function AudioSource({ value, onChange, disabled }: { value: SourceFile | null; onChange: (f: SourceFile | null) => void; disabled?: boolean }) {
  const [mode, setMode] = useState<Mode>("upload");
  return (
    <div className="space-y-3">
      <Segmented
        ariaLabel="Audio source"
        value={mode}
        onChange={(m) => {
          setMode(m);
          onChange(null);
        }}
        options={[
          { value: "upload", label: "Upload", icon: <Upload className="size-3.5" /> },
          { value: "record", label: "Record", icon: <Mic className="size-3.5" /> },
        ]}
      />
      {value ? (
        <FilePreview file={value} onClear={() => onChange(null)} disabled={disabled} />
      ) : mode === "upload" ? (
        <DropZone onFile={onChange} disabled={disabled} />
      ) : (
        <RecordPanel onDone={onChange} disabled={disabled} />
      )}
    </div>
  );
}

async function withDuration(blob: Blob, name: string): Promise<SourceFile> {
  const url = URL.createObjectURL(blob);
  const duration = await new Promise<number | null>((resolve) => {
    const a = new Audio();
    a.preload = "metadata";
    a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => resolve(null);
    a.src = url;
  });
  URL.revokeObjectURL(url);
  return { blob, name, duration };
}

function DropZone({ onFile, disabled }: { onFile: (f: SourceFile) => void; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const take = async (f: File | undefined) => {
    if (!f) return;
    onFile(await withDuration(f, f.name));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    void take(e.dataTransfer.files[0]);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
        over ? "border-fire bg-fire-soft/40" : "border-line-strong bg-surface-2/60",
        disabled && "opacity-50",
      )}
    >
      <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-surface text-muted shadow-sm">
        <FileAudio className="size-6" />
      </div>
      <p className="text-[14px] font-medium text-ink">Drop an audio or video file</p>
      <p className="mt-0.5 text-[12.5px] text-muted">Anything ffmpeg reads: wav, mp3, m4a, ogg, flac, mp4, webm…</p>
      <Button size="sm" className="mt-4" onClick={() => inputRef.current?.click()} disabled={disabled} leading={<Upload className="size-4" />}>
        Browse
      </Button>
      <input ref={inputRef} type="file" accept="audio/*,video/*" className="sr-only" aria-label="Choose a file" onChange={(e) => void take(e.target.files?.[0])} />
    </div>
  );
}

function RecordPanel({ onDone, disabled }: { onDone: (f: SourceFile) => void; disabled?: boolean }) {
  const recRef = useRef<Recorder | null>(null);
  const [active, setActive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(24).fill(0));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const t0 = Date.now();
    let raf = 0;
    const tick = () => {
      setElapsed((Date.now() - t0) / 1000);
      const lvl = recRef.current?.level() ?? 0;
      setLevels((prev) => [...prev.slice(1), Math.min(1, lvl * 3)]);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  useEffect(() => () => void recRef.current?.stop(), []);

  const start = async () => {
    setError(null);
    try {
      const r = new Recorder();
      await r.start();
      recRef.current = r;
      setElapsed(0);
      setActive(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Microphone unavailable");
    }
  };
  const stop = async () => {
    const r = recRef.current;
    if (!r) return;
    setActive(false);
    const blob = await r.stop();
    recRef.current = null;
    const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
    onDone(await withDuration(blob, `recording-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`));
  };

  return (
    <div className="surface flex flex-col items-center rounded-xl px-6 py-8">
      <div className="flex h-12 items-end gap-[3px]" aria-hidden>
        {levels.map((l, i) => (
          <span key={i} className={cn("w-[4px] rounded-full transition-[height] duration-75", active ? "bg-fire" : "bg-surface-3")} style={{ height: `${Math.max(8, l * 100)}%` }} />
        ))}
      </div>
      <p className="mt-3 text-[22px] font-semibold text-ink tabular" aria-live="polite">
        {fmtTime(elapsed)}
      </p>
      <p className="text-[12.5px] text-muted">{active ? "Recording from your microphone" : "Record a clip to transcribe"}</p>
      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-bad">
          {error}
        </p>
      )}
      <div className="mt-4">
        {active ? (
          <Button variant="danger" size="lg" onClick={() => void stop()} leading={<Square className="size-4 fill-current" />}>
            Stop
          </Button>
        ) : (
          <Button variant="primary" size="lg" onClick={() => void start()} disabled={disabled} leading={<Mic className="size-4" />}>
            Start recording
          </Button>
        )}
      </div>
    </div>
  );
}

function FilePreview({ file, onClear, disabled }: { file: SourceFile; onClear: () => void; disabled?: boolean }) {
  return (
    <div className="surface flex items-center gap-3 rounded-xl px-4 py-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-fire-soft text-fire">
        <FileAudio className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium text-ink">{file.name}</p>
        <p className="text-[12px] text-muted tabular">
          {fmtBytes(file.blob.size)}
          {file.duration != null && ` · ${fmtTime(file.duration)}`}
        </p>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Remove file" onClick={onClear} disabled={disabled}>
        <X className="size-4" />
      </Button>
    </div>
  );
}
