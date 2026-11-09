import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const field =
  "w-full rounded-md border border-line bg-surface-2 px-3 text-sm text-ink placeholder:text-faint transition-[border,box-shadow,background] " +
  "hover:border-line-strong focus:border-fire/60 focus:bg-surface focus:shadow-[0_0_0_3px_var(--fire-soft)] focus:outline-none disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { leading?: ReactNode; trailing?: ReactNode }>(
  function Input({ className, leading, trailing, ...rest }, ref) {
    if (!leading && !trailing) return <input ref={ref} className={cn(field, "h-9", className)} {...rest} />;
    return (
      <div className={cn("relative flex items-center", className)}>
        {leading && <span className="pointer-events-none absolute left-3 text-muted [&>svg]:size-4">{leading}</span>}
        <input ref={ref} className={cn(field, "h-9", leading && "pl-9", trailing && "pr-9")} {...rest} />
        {trailing && <span className="absolute right-2 flex items-center text-muted">{trailing}</span>}
      </div>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(field, "min-h-24 resize-y py-2 leading-relaxed", className)} {...rest} />;
});

export function NativeSelect({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(field, "h-9 appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-8", className)} {...rest}>
      {children}
    </select>
  );
}
