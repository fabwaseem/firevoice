import { Link } from "react-router";
import { useHealth, useSystem } from "@/lib/api/hooks";
import { cn, fmtGB } from "@/lib/utils";
import { Tooltip } from "@/components/ui";

/** Small connection + GPU readout at the bottom of the sidebar. */
export function ServerStatus({ compact }: { compact?: boolean }) {
  const health = useHealth();
  const online = health.isSuccess;
  const system = useSystem(online);
  const gpu = system.data?.gpu;
  const total = gpu?.vram_total_gb;
  const used = gpu?.vram_used_gb ?? (total != null && gpu?.vram_free_gb != null ? total - gpu.vram_free_gb : null);
  const pct = total && used != null ? used / total : 0;

  const label = online ? (gpu?.name ? `${gpu.name}: ${fmtGB(used)} of ${fmtGB(total)} VRAM in use` : "Connected") : "Server offline";

  return (
    <Tooltip content={label} side="right">
      <Link
        to="/settings"
        aria-label={label}
        className={cn(
          "mt-2 flex flex-col items-center gap-1.5 rounded-xl px-2 py-2 transition-colors hover:bg-surface/60",
        )}
      >
        <span className="flex items-center gap-1.5">
          <span className={cn("size-2 rounded-full", online ? "bg-ok shadow-[0_0_0_3px_var(--ok-soft)]" : health.isLoading ? "bg-warn animate-pulse" : "bg-bad shadow-[0_0_0_3px_var(--bad-soft)]")} />
          {!compact && <span className="text-[11px] font-medium text-muted">{online ? "online" : health.isLoading ? "connecting" : "offline"}</span>}
        </span>
        {online && total ? (
          <span className="h-1 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <span className={cn("block h-full rounded-full", pct > 0.9 ? "bg-bad" : pct > 0.7 ? "bg-warn" : "bg-ok")} style={{ width: `${Math.round(pct * 100)}%` }} />
          </span>
        ) : null}
      </Link>
    </Tooltip>
  );
}
