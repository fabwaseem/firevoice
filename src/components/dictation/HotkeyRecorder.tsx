import { useEffect, useRef, useState } from "react";
import { Keyboard } from "@/components/icons";
import { Kbd } from "@/components/ui";
import { hotkeyFromEvent, hotkeyLabels } from "@/lib/dictation";
import { cn } from "@/lib/utils";

/** Shows the dictation hotkey as key caps; click it and press a new combination to change it (Esc keeps the old one). */
export function HotkeyRecorder({ value, onChange, disabled }: { value: string; onChange: (hotkey: string) => void; disabled?: boolean }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setRecording(false);
        setHint(null);
        return;
      }
      const { hotkey, reason } = hotkeyFromEvent(e);
      if (hotkey) {
        onChange(hotkey);
        setRecording(false);
        setHint(null);
      } else if (reason) setHint(reason);
    };
    const stop = () => setRecording(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", stop);
    };
  }, [recording, onChange]);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        onClick={() => setRecording((r) => !r)}
        onBlur={() => setRecording(false)}
        aria-label={recording ? "Press the new key combination" : `Dictation hotkey: ${hotkeyLabels(value).join(" plus ")}. Press to change.`}
        className={cn(
          "flex h-9 min-w-[150px] items-center justify-center gap-1.5 rounded-[10px] border px-3 text-[12.5px] outline-none transition-[border-color,box-shadow,background]",
          "focus-visible:shadow-[0_0_0_3px_var(--fire-soft)] disabled:opacity-50",
          recording ? "border-fire bg-fire-soft text-fire" : "border-line-strong bg-surface text-ink hover:bg-surface-2",
        )}
      >
        {recording ? (
          <>
            <Keyboard className="size-3.5" /> Press the keys…
          </>
        ) : (
          hotkeyLabels(value).map((k, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-faint">+</span>}
              <Kbd>{k}</Kbd>
            </span>
          ))
        )}
      </button>
      {recording && <span className="text-[11.5px] text-muted">{hint ?? "Esc keeps the current one."}</span>}
    </div>
  );
}
