import { useMemo, useState, type ComponentType } from "react";
import * as RP from "@radix-ui/react-popover";
import {
  BookOpen,
  Check,
  ChevronDown,
  Clapperboard,
  Coffee,
  Ear,
  Film,
  Flame,
  Frown,
  GraduationCap,
  HelpCircle,
  Lightbulb,
  Meh,
  Mic2,
  Moon,
  Newspaper,
  Search,
  Skull,
  Sparkles,
  Trophy,
  Waves,
  Wind,
  Zap,
} from "lucide-react";
import type { Style } from "@/lib/api/types";
import { Input } from "@/components/ui";
import { cn } from "@/lib/utils";

type Icon = ComponentType<{ className?: string }>;

/** An icon and a hue per built-in style; custom styles get a sparkle and a hue from their name. */
const LOOK: Record<string, [Icon, number]> = {
  angry: [Flame, 8],
  asmr: [Ear, 280],
  audiobook: [BookOpen, 32],
  bedtime: [Moon, 245],
  calm: [Wind, 170],
  conversational: [Coffee, 24],
  curious: [HelpCircle, 200],
  deadpan: [Meh, 220],
  documentary: [Film, 150],
  dramatic: [Clapperboard, 330],
  excited: [Zap, 45],
  explainer: [Lightbulb, 52],
  horror: [Skull, 0],
  neutral: [Waves, 215],
  newscaster: [Newspaper, 210],
  podcast: [Mic2, 265],
  reflective: [Sparkles, 190],
  sad: [Frown, 225],
  serious: [GraduationCap, 230],
  sports: [Trophy, 38],
  storyteller: [BookOpen, 300],
  trailer: [Clapperboard, 12],
};

function look(s?: Pick<Style, "name"> | null): [Icon, number] {
  if (!s) return [Waves, 215];
  if (LOOK[s.name]) return LOOK[s.name];
  let h = 0;
  for (const c of s.name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return [Sparkles, h];
}

function StyleTile({ style, className }: { style?: Style | null; className?: string }) {
  const [Icon, hue] = look(style);
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center rounded-[11px] text-white", className)}
      style={{ background: `linear-gradient(135deg, hsl(${hue} 85% 62%), hsl(${(hue + 24) % 360} 80% 50%))` }}
      aria-hidden
    >
      <Icon className="size-[45%]" />
    </span>
  );
}

/** Delivery style: a card like the voice card, opening a searchable grid of every style with what it sounds like. */
export function StylePicker({ styles, value, onChange, disabled, className }: { styles: Style[]; value: string; onChange: (v: string) => void; disabled?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selected = styles.find((s) => s.name === value) ?? null;
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    const all = n ? styles.filter((s) => [s.title, s.name, s.description, s.instruct, ...(s.tags ?? [])].join(" ").toLowerCase().includes(n)) : styles;
    // custom styles first, then the built-in ones alphabetically
    return [...all].sort((a, b) => Number(a.builtin !== false) - Number(b.builtin !== false) || (a.title || a.name).localeCompare(b.title || b.name));
  }, [styles, q]);

  return (
    <RP.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); }}>
      <RP.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Choose delivery style"
          className={cn(
            "group flex w-full items-center gap-3 rounded-xl border border-line bg-surface-2 p-2 pr-3 text-left transition-[border,box-shadow,background] hover:border-line-strong",
            "data-[state=open]:border-fire/60 data-[state=open]:shadow-[0_0_0_3px_var(--fire-soft)] disabled:opacity-50",
            className,
          )}
        >
          <StyleTile style={selected} className="size-11" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13.5px] font-semibold text-ink">{selected?.title || selected?.name || "Choose a style"}</span>
              {selected && selected.builtin === false && <span className="rounded-full bg-info-soft px-1.5 text-[10.5px] font-semibold text-info">Custom</span>}
            </span>
            <span className="block truncate text-[12px] text-muted">{selected?.description || selected?.instruct || "How the voice delivers the script"}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </RP.Trigger>
      <RP.Portal>
        <RP.Content
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="surface-raised z-50 flex max-h-[min(560px,var(--radix-popover-content-available-height))] w-[min(620px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl fade-up"
        >
          <div className="border-b border-line p-3">
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search styles: calm, story, news…" leading={<Search className="size-4" />} aria-label="Search styles" />
          </div>
          <div role="radiogroup" aria-label="Delivery style" className="grid flex-1 grid-cols-1 gap-1.5 overflow-y-auto p-2 sm:grid-cols-2">
            {list.map((s) => {
              const on = s.name === value;
              return (
                <button
                  key={s.name}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    onChange(s.name);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex items-start gap-3 rounded-xl p-2.5 text-left transition-colors",
                    on ? "bg-fire-soft" : "hover:bg-surface-2",
                  )}
                >
                  <StyleTile style={s} className="size-9" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={cn("truncate text-[13.5px] font-semibold", on ? "text-fire" : "text-ink")}>{s.title || s.name}</span>
                      {s.builtin === false && <span className="rounded-full bg-info-soft px-1.5 text-[10.5px] font-semibold text-info">Custom</span>}
                      {on && <Check className="ml-auto size-4 shrink-0 text-fire" />}
                    </span>
                    <span className="line-clamp-2 text-[12px] leading-snug text-muted">{s.description || s.instruct || "—"}</span>
                  </span>
                </button>
              );
            })}
            {list.length === 0 && <p className="col-span-full px-3 py-8 text-center text-[13px] text-muted">No style matches “{q}”.</p>}
          </div>
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}
