import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { FileAudio, Upload, X } from "lucide-react";
import { cn, fmtBytes } from "@/lib/utils";

/** A compact file picker: one button that says "Choose a file" or shows the picked file (name and size), takes a
 * dropped file too, and an optional line under it (a "Try a sample" link). */
export function FilePick({
  file,
  onFile,
  accept = "audio/*,video/*",
  label = "Choose a file",
  below,
  className,
  disabled,
}: {
  file: File | null;
  onFile: (f: File | null) => void;
  accept?: string;
  label?: string;
  below?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn(
          "flex h-9 min-w-0 items-center gap-2 rounded-[10px] border border-dashed pr-1 pl-3 text-[13px] transition-colors",
          over ? "border-fire bg-fire-soft" : file ? "border-line bg-surface-2" : "border-line-strong bg-surface-2 hover:border-fire/50",
        )}
      >
        <input ref={input} type="file" accept={accept} className="sr-only" disabled={disabled} onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        <button type="button" disabled={disabled} onClick={() => input.current?.click()} className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none disabled:opacity-50">
          {file ? <FileAudio className="size-4 shrink-0 text-fire" /> : <Upload className="size-4 shrink-0 text-muted" />}
          <span className={cn("truncate", file ? "font-medium text-ink" : "text-muted")} title={file?.name}>{file ? file.name : label}</span>
          {file && <span className="shrink-0 text-[11.5px] text-faint tabular">{fmtBytes(file.size)}</span>}
        </button>
        {file && (
          <button type="button" aria-label="Remove file" onClick={() => onFile(null)} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-3 hover:text-ink">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {below && <div className="pl-1">{below}</div>}
    </div>
  );
}
