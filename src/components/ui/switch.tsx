import * as RSw from "@radix-ui/react-switch";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onChange,
  label,
  description,
  className,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  className?: string;
  disabled?: boolean;
  id?: string;
}) {
  const control = (
    <RSw.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      className={cn(
        "relative h-[22px] w-[38px] shrink-0 rounded-full border border-transparent bg-surface-3 transition-colors",
        "data-[state=checked]:fire-gradient focus:outline-none focus-visible:shadow-[0_0_0_3px_var(--fire-soft)] disabled:opacity-50",
      )}
    >
      <RSw.Thumb className="block size-[18px] translate-x-[1px] rounded-full bg-white shadow-sm transition-transform duration-200 ease-[var(--ease-spring)] data-[state=checked]:translate-x-[17px]" />
    </RSw.Root>
  );
  if (!label) return control;
  return (
    <label className={cn("flex cursor-pointer items-center justify-between gap-4", disabled && "cursor-not-allowed", className)}>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        {description && <span className="block text-[12px] text-muted">{description}</span>}
      </span>
      {control}
    </label>
  );
}
