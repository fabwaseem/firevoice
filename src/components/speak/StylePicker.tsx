import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Style } from "@/lib/api/types";
import { Chip, Tooltip } from "@/components/ui";
import { cn } from "@/lib/utils";

/** Horizontal, scrollable row of delivery styles. */
export function StylePicker({ styles, value, onChange, disabled, className }: { styles: Style[]; value: string; onChange: (v: string) => void; disabled?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (d: number) => ref.current?.scrollBy({ left: d, behavior: "smooth" });
  return (
    <div className={cn("group/sp relative", className)}>
      <div ref={ref} role="radiogroup" aria-label="Delivery style" className="flex gap-1.5 overflow-x-auto scroll-smooth pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {styles.map((s) => (
          <Tooltip key={s.name} content={s.description || s.instruct || s.title} side="bottom">
            <Chip role="radio" aria-checked={s.name === value} active={s.name === value} disabled={disabled} onClick={() => onChange(s.name)}>
              {s.title || s.name}
              {!s.builtin && <span className="size-1.5 rounded-full bg-info" aria-label="custom" />}
            </Chip>
          </Tooltip>
        ))}
      </div>
      <button type="button" aria-label="Scroll styles left" onClick={() => scroll(-240)} className="absolute top-1/2 -left-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-surface/95 text-muted shadow-md opacity-0 transition-opacity group-hover/sp:opacity-100 hover:text-ink">
        <ChevronLeft className="size-4" />
      </button>
      <button type="button" aria-label="Scroll styles right" onClick={() => scroll(240)} className="absolute top-1/2 -right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-surface/95 text-muted shadow-md opacity-0 transition-opacity group-hover/sp:opacity-100 hover:text-ink">
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}
