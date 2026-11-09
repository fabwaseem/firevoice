import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Page-level title row: large heading, one-line subtitle, actions on the right. */
export function PageHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn("mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        {subtitle && <div className="mt-0.5 text-[13.5px] text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Centered error panel for a failed page load. */
export function LoadError({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div role="alert" className="surface mx-auto mt-16 max-w-md rounded-xl p-6 text-center">
      <p className="text-[14px] font-medium text-ink">Could not load this page</p>
      <p className="mt-1 text-[13px] text-muted">{message}</p>
      {retry && (
        <button type="button" onClick={retry} className="mt-4 text-[13px] font-medium text-fire hover:underline">
          Try again
        </button>
      )}
    </div>
  );
}
