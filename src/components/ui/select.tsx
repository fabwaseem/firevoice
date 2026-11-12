import * as RS from "@radix-ui/react-select";
import { Check, ChevronDown } from "@/components/icons";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  group?: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  className,
  size = "md",
  ariaLabel,
  disabled,
}: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  size?: "sm" | "md";
  ariaLabel?: string;
  disabled?: boolean;
}) {
  // Radix forbids "" as an item value; map it to a sentinel so "Any …" options work.
  const EMPTY = "__fv_empty__";
  const enc = (v: string) => (v === "" ? EMPTY : v);
  const groups = new Map<string | undefined, SelectOption[]>();
  for (const o of options) {
    const g = groups.get(o.group) ?? [];
    g.push({ ...o, value: enc(o.value) });
    groups.set(o.group, g);
  }
  const hasEmpty = options.some((o) => o.value === "");
  const current = value == null || (value === "" && !hasEmpty) ? undefined : enc(value);
  return (
    <RS.Root value={current} onValueChange={(v) => onChange(v === EMPTY ? "" : v)} disabled={disabled}>
      <RS.Trigger
        aria-label={ariaLabel}
        className={cn(
          "group flex w-full items-center justify-between gap-2 rounded-md border border-line bg-surface-2 text-left text-ink transition-[border,box-shadow,background]",
          "hover:border-line-strong focus:outline-none focus-visible:border-fire/60 focus-visible:shadow-[0_0_0_3px_var(--fire-soft)] data-[state=open]:border-fire/60",
          "disabled:opacity-50 data-[placeholder]:text-faint",
          size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3 text-sm",
          className,
        )}
      >
        <span className="truncate">
          <RS.Value placeholder={placeholder} />
        </span>
        <RS.Icon>
          <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-data-[state=open]:rotate-180" />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          className="surface-raised z-50 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg p-1 fade-up"
        >
          <RS.Viewport>
            {[...groups.entries()].map(([group, items]) => (
              <RS.Group key={group ?? "_"}>
                {group && <RS.Label className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">{group}</RS.Label>}
                {items.map((o) => (
                  <RS.Item
                    key={o.value}
                    value={o.value}
                    disabled={o.disabled}
                    className="relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2.5 text-sm text-ink outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-3"
                  >
                    <div className="min-w-0 flex-1">
                      <RS.ItemText>{o.label}</RS.ItemText>
                      {o.description && <div className="truncate text-[12px] text-muted">{o.description}</div>}
                    </div>
                    <RS.ItemIndicator className="absolute right-2.5 text-fire">
                      <Check className="size-4" />
                    </RS.ItemIndicator>
                  </RS.Item>
                ))}
              </RS.Group>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
