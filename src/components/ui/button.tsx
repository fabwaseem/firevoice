import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger" | "soft";
type Size = "xs" | "sm" | "md" | "lg" | "icon" | "icon-sm" | "icon-lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary:
    "fire-gradient text-white shadow-[0_6px_18px_-6px_rgba(255,90,45,0.55)] hover:brightness-105 active:brightness-95 disabled:shadow-none",
  secondary: "bg-ink text-bg hover:opacity-90 active:opacity-80 dark:bg-ink dark:text-bg",
  soft: "bg-fire-soft text-fire hover:bg-[color-mix(in_srgb,var(--fire-soft)_80%,var(--fire)_20%)]",
  ghost: "text-ink-2 hover:bg-surface-3 hover:text-ink active:bg-surface-3",
  outline: "surface text-ink hover:bg-surface-2 active:bg-surface-3",
  danger: "bg-bad-soft text-bad hover:bg-[color-mix(in_srgb,var(--bad-soft)_70%,var(--bad)_30%)]",
};

const sizes: Record<Size, string> = {
  xs: "h-7 px-2.5 text-xs gap-1.5 rounded-sm",
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-[10px]",
  md: "h-9 px-4 text-sm gap-2 rounded-md",
  lg: "h-11 px-5 text-[15px] gap-2 rounded-lg",
  icon: "h-9 w-9 rounded-md",
  "icon-sm": "h-8 w-8 rounded-[10px]",
  "icon-lg": "h-11 w-11 rounded-lg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "outline", size = "md", loading, leading, trailing, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-[background,color,box-shadow,filter,transform] duration-150 select-none",
        "disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.985]",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : leading}
      {children}
      {!loading && trailing}
    </button>
  );
});
