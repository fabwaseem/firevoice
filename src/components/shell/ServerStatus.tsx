import { Link } from "react-router";
import { useHealth, useSystem } from "@/lib/api/hooks";
import { cn, fmtGB } from "@/lib/utils";
import { Tooltip } from "@/components/ui";

/** Connection and GPU memory at the bottom of the sidebar. */
export function ServerStatus({ compact }: { compact?: boolean }) {
  const health = useHealth();
  const online = health.isSuccess;
  const system = useSystem(online);
  const gpu = system.data?.gpu;
  const total = gpu?.vram_total_gb;
  const used = gpu?.vram_used_gb ?? (total != null && gpu?.vram_free_gb != null ? total - gpu.vram_free_gb : null);
  const pct = total && used != null ? used / total : 0;
  const state = online ? "Online" : health.isLoading ? "Connecting" : "Offline";
  const gpuName = gpu?.name?.replace(/^NVIDIA\s+(GeForce\s+)?/i, "") ?? null;
  const label = online ? (gpu?.name ? `${gpu.name}: ${fmtGB(used)} of ${fmtGB(total)} in use` : "Connected") : "Voice engine is not running";
  const dot = (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        online ? "bg-ok shadow-[0_0_0_3px_var(--ok-soft)]" : health.isLoading ? "animate-pulse bg-warn" : "bg-bad shadow-[0_0_0_3px_var(--bad-soft)]",
      )}
    />
  );
  const bar = online && total ? (
    <span className="block h-1 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
      <span
        className={cn("block h-full rounded-full transition-[width] duration-500", pct > 0.9 ? "bg-bad" : pct > 0.7 ? "bg-warn" : "bg-ok")}
        style={{ width: `${Math.max(3, Math.round(pct * 100))}%` }}
      />
    </span>
  ) : null;

  if (compact) {
    return (
      <Tooltip content={`${state} · ${label}`} side="right">
        <Link to="/engines" aria-label={label} className="mx-auto flex w-10 flex-col items-center gap-1.5 rounded-[10px] py-2 transition-colors hover:bg-surface-3/70">
          {dot}
          {bar}
        </Link>
      </Tooltip>
    );
  }
  // one line: the state, the card, and how full its memory is as a small bar with the number beside it
  return (
    <Tooltip content={label} side="right">
      <Link to="/engines" aria-label={label} className="flex h-8 items-center gap-2 rounded-[9px] px-2.5 transition-colors hover:bg-surface-3/70">
        {dot}
        <span className="shrink-0 text-[12px] font-medium text-ink-2">{state}</span>
        {bar ? (
          <span className="ml-auto flex min-w-0 items-center gap-1.5">
            <span className="w-10 shrink-0">{bar}</span>
            <span className="shrink-0 text-[10.5px] text-faint tabular">
              {used != null ? used.toFixed(1) : "–"}/{total?.toFixed(0)} GB
            </span>
          </span>
        ) : (
          gpuName && <span className="ml-auto truncate text-[11px] text-faint">{gpuName}</span>
        )}
      </Link>
    </Tooltip>
  );
}
