import { useEffect, useMemo, useRef } from "react";
import type { WordTime } from "@/lib/api/types";
import { activeWordIndex, usePlayer } from "@/stores/player";
import { cn } from "@/lib/utils";

/** Karaoke-style transcript: highlights the word under the playhead; click a word to seek. */
export function ReadAlong({ words, className }: { words: WordTime[]; className?: string }) {
  const position = usePlayer((s) => s.position);
  const live = usePlayer((s) => s.live);
  const requestSeek = usePlayer((s) => s.requestSeek);
  const active = useMemo(() => activeWordIndex(words, position), [words, position]);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  if (!words.length) return null;

  return (
    <div className={cn("max-h-40 overflow-y-auto rounded-xl bg-surface-2/70 px-4 py-3 leading-[2]", className)} aria-label="Read along" role="region">
      {words.map((w, i) => {
        const on = i === active;
        const past = i < active;
        return (
          <button
            key={`${i}-${w.start}`}
            ref={on ? activeRef : undefined}
            type="button"
            disabled={live}
            onClick={() => requestSeek(w.start)}
            className={cn(
              "rounded-[6px] px-1 py-0.5 text-[15px] transition-colors duration-100",
              on ? "fire-gradient text-white shadow-[0_2px_8px_-2px_rgba(255,90,45,0.6)]" : past ? "text-ink" : "text-muted",
              !live && "hover:bg-surface-3",
            )}
          >
            {w.text}
          </button>
        );
      })}
    </div>
  );
}
