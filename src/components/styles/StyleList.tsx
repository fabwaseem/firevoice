import { motion } from "motion/react";
import { Lock, Tag } from "@/components/icons";
import type { Style } from "@/lib/api/types";
import { cn, truncate } from "@/lib/utils";
import { Skeleton } from "@/components/ui";

export function StyleList({ styles, selected, onSelect }: { styles: Style[]; selected: string | null; onSelect: (name: string) => void }) {
  const builtin = styles.filter((s) => s.builtin).sort((a, b) => a.name.localeCompare(b.name));
  const custom = styles.filter((s) => !s.builtin).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <nav aria-label="Styles" className="flex flex-col gap-4">
      {custom.length > 0 && <Group title="Custom" items={custom} selected={selected} onSelect={onSelect} />}
      <Group title="Built-in" items={builtin} selected={selected} onSelect={onSelect} />
      {custom.length === 0 && (
        <p className="px-1 text-[12px] text-muted">Custom styles you save appear above the built-in ones and can override them by name.</p>
      )}
    </nav>
  );
}

function Group({ title, items, selected, onSelect }: { title: string; items: Style[]; selected: string | null; onSelect: (n: string) => void }) {
  return (
    <section>
      <h3 className="mb-1.5 px-1 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
        {title} <span className="text-faint">· {items.length}</span>
      </h3>
      <ul className="flex flex-col gap-0.5">
        {items.map((s, i) => {
          const on = s.name === selected;
          return (
            <motion.li key={s.name} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25, delay: Math.min(i, 15) * 0.015 }}>
              <button
                type="button"
                onClick={() => onSelect(s.name)}
                aria-current={on ? "true" : undefined}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-[background,box-shadow]",
                  on ? "surface shadow-sm" : "hover:bg-surface/70",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className={cn("truncate text-[13.5px] font-semibold", on ? "text-fire" : "text-ink")}>{s.title || s.name}</span>
                    <span className="truncate font-mono text-[11px] text-faint">{s.name}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-muted">{s.description ? truncate(s.description, 70) : s.instruct ? truncate(s.instruct, 70) : "—"}</span>
                </span>
                <span className="mt-0.5 flex shrink-0 items-center gap-2 text-faint">
                  {s.tags?.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[11px] tabular" title={`${s.tags.length} suggested tags`}>
                      <Tag className="size-3" /> {s.tags.length}
                    </span>
                  )}
                  {s.builtin && <Lock className="size-3" aria-label="Built-in" />}
                </span>
              </button>
            </motion.li>
          );
        })}
      </ul>
    </section>
  );
}

export function StyleListSkeleton() {
  return (
    <div className="flex flex-col gap-2" role="status" aria-busy aria-label="Loading styles">
      <Skeleton className="h-3 w-20" />
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}
