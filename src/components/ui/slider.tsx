import * as RSl from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  className,
  ariaLabel,
  disabled,
  accent = true,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  accent?: boolean;
}) {
  return (
    <RSl.Root
      value={[value]}
      onValueChange={([v]) => onChange(v)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn("group relative flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-50", className)}
    >
      <RSl.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-surface-3">
        <RSl.Range className={cn("absolute h-full rounded-full", accent ? "fire-gradient" : "bg-ink-2")} />
      </RSl.Track>
      <RSl.Thumb
        aria-label={ariaLabel}
        className="block size-4 rounded-full border border-line-strong bg-surface shadow-md transition-transform group-hover:scale-110 focus:outline-none focus-visible:shadow-[0_0_0_4px_var(--fire-soft)] data-[disabled]:cursor-not-allowed"
      />
    </RSl.Root>
  );
}

/** Slider with a label row showing the current value; the row's value is editable by typing. */
export function LabeledSlider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  format = (v: number) => String(v),
  hint,
  className,
  disabled,
  onReset,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  hint?: string;
  className?: string;
  disabled?: boolean;
  onReset?: () => void;
}) {
  return (
    <div className={cn("group/ls", className)}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-ink-2" title={hint}>
          {label}
        </span>
        <span className="flex items-center gap-2">
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              className="text-[11px] text-faint opacity-0 transition-opacity hover:text-fire group-hover/ls:opacity-100 focus-visible:opacity-100"
            >
              reset
            </button>
          )}
          <input
            type="number"
            aria-label={`${label} value`}
            value={value}
            step={step}
            min={min}
            max={max}
            disabled={disabled}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
            }}
            className="w-16 rounded-sm border border-transparent bg-transparent px-1 text-right text-[12px] text-muted tabular hover:border-line focus:border-fire/60 focus:bg-surface focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="sr-only">{format(value)}</span>
        </span>
      </div>
      <Slider value={value} onChange={onChange} min={min} max={max} step={step} ariaLabel={label} disabled={disabled} />
    </div>
  );
}
