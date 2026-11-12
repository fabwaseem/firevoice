import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { FileAudio, RefreshCw, UploadCloud, X } from "@/components/icons";
import { AudioPlayer, Card } from "@/components/ui";
import { cn, fmtBytes } from "@/lib/utils";
import { TrySample, type SampleName } from "./TrySample";

/** A numbered step heading inside a tool: "1  Your file". */
export function Step({ n, title, hint, children, className }: { n: number; title: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2.5", className)}>
      <div className="flex items-baseline gap-2.5">
        <span className="flex size-5 shrink-0 translate-y-[3px] items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-ink-2 tabular">{n}</span>
        <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
        {hint && <span className="ml-auto text-[12px] text-faint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** A large drop area for one audio or video file. Once a file is in, it shows the file with a player to hear it,
 * and buttons to replace or remove it. */
export function DropZone({
  file,
  onFile,
  sample,
  accept = "audio/*,video/*",
  disabled,
}: {
  file: File | null;
  onFile: (f: File | null) => void;
  sample?: SampleName;
  accept?: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const src = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && !disabled) onFile(f);
  };
  const pick = () => input.current?.click();
  const hidden = (
    <input ref={input} type="file" accept={accept} className="sr-only" disabled={disabled} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
  );

  if (file && src) {
    return (
      <div className="space-y-2.5" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
        {hidden}
        <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fire-soft text-fire">
            <FileAudio className="size-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-medium text-ink" title={file.name}>{file.name}</span>
            <span className="block text-[11.5px] text-faint tabular">{fmtBytes(file.size)}</span>
          </span>
          <button type="button" onClick={pick} disabled={disabled} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-50">
            <RefreshCw className="size-3.5" /> Replace
          </button>
          <button type="button" aria-label="Remove file" onClick={() => onFile(null)} disabled={disabled} className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-50">
            <X className="size-4" />
          </button>
        </div>
        <AudioPlayer src={src} label={file.name} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        role="button"
        tabIndex={0}
        aria-label="Choose an audio or video file"
        onClick={pick}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick())}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn(
          "group flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-9 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-fire/40",
          over ? "border-fire bg-fire-soft" : "border-line-strong bg-surface-2/60 hover:border-fire/50 hover:bg-surface-2",
        )}
      >
        {hidden}
        <span className={cn("mb-3 flex size-12 items-center justify-center rounded-2xl transition-colors", over ? "fire-gradient text-white" : "bg-surface-3 text-muted group-hover:text-fire")}>
          <UploadCloud className="size-6" />
        </span>
        <span className="text-[14px] font-semibold text-ink">{over ? "Drop it here" : "Drop an audio or video file"}</span>
        <span className="mt-1 text-[12.5px] text-muted">
          or <span className="font-medium text-fire">choose a file</span> · MP3, WAV, M4A, MP4 and more
        </span>
      </div>
      {sample && (
        <p className="flex items-center gap-1.5 pl-1 text-[12px] text-faint">
          Nothing to hand? <TrySample name={sample} onFile={onFile} disabled={disabled} />
        </p>
      )}
    </div>
  );
}

/** Two columns: what goes in (file, options, the action) on the left, what comes out on the right. */
export function ToolWorkspace({ input, result }: { input: ReactNode; result: ReactNode }) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <Card className="space-y-6 p-5">{input}</Card>
      <Card className="min-h-[340px] p-5">{result}</Card>
    </div>
  );
}

/** The result column before anything has run. */
export function ResultEmpty({ icon, title, children }: { icon: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[300px] flex-col items-center justify-center rounded-xl bg-[radial-gradient(circle,var(--line)_1px,transparent_1px)] [background-size:16px_16px] px-6 text-center">
      <span className="mb-4 flex size-14 items-center justify-center rounded-2xl border border-line bg-surface text-faint shadow-sm [&>svg]:size-6">{icon}</span>
      <h3 className="text-[14.5px] font-semibold text-ink">{title}</h3>
      {children && <div className="mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

/** The result column while a tool runs. */
export function Working({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  return (
    <div role="status" className="flex h-full min-h-[300px] flex-col items-center justify-center text-center">
      <div className="mb-5 flex h-10 items-center gap-[5px]" aria-hidden>
        {Array.from({ length: 9 }).map((_, i) => (
          <span key={i} className="tool-working-bar w-[5px] rounded-full fire-gradient" style={{ animationDelay: `${i * 90}ms` }} />
        ))}
      </div>
      <h3 className="text-[14.5px] font-semibold text-ink">{title}</h3>
      {hint && <p className="mt-1 max-w-sm text-[12.5px] text-muted">{hint}</p>}
    </div>
  );
}

/** A heading over a result: icon, title, and a line of detail. */
export function ResultHeader({ icon, title, detail, tone = "neutral", aside }: { icon: ReactNode; title: ReactNode; detail?: ReactNode; tone?: "ok" | "warn" | "neutral"; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5">
      <span
        className={cn(
          "flex size-12 shrink-0 items-center justify-center rounded-2xl [&>svg]:size-6",
          tone === "ok" ? "bg-ok-soft text-ok" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-surface-3 text-muted",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-ink">{title}</h3>
        {detail && <p className="mt-0.5 text-[12.5px] text-muted">{detail}</p>}
      </div>
      {aside}
    </div>
  );
}
