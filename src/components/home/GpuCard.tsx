import { Link } from "react-router";
import { Cpu, Ear, Loader2, X } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, Skeleton, Tooltip } from "@/components/ui";
import { useSystem, useUnloadEngine } from "@/lib/api/hooks";
import { cn, fmtGB } from "@/lib/utils";

function VramRing({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(1, used / total) : 0;
  const r = 34;
  const c = 2 * Math.PI * r;
  const tone = pct > 0.9 ? "var(--bad)" : pct > 0.7 ? "var(--warn)" : "var(--ok)";
  return (
    <div className="relative size-[88px] shrink-0" role="img" aria-label={`${Math.round(pct * 100)}% of VRAM in use`}>
      <svg viewBox="0 0 80 80" className="size-full -rotate-90">
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="7" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          className="transition-[stroke-dashoffset] duration-700 ease-[var(--ease-out-quart)]"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[17px] font-semibold tabular text-ink">{Math.round(pct * 100)}%</span>
        <span className="text-[10px] font-medium tracking-wider text-faint uppercase">vram</span>
      </div>
    </div>
  );
}

export function GpuCard() {
  const system = useSystem();
  const unload = useUnloadEngine();
  const s = system.data;
  const gpu = s?.gpu;
  const total = gpu?.vram_total_gb ?? 0;
  const used = gpu?.vram_used_gb ?? (gpu?.vram_total_gb != null && gpu.vram_free_gb != null ? gpu.vram_total_gb - gpu.vram_free_gb : 0);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title="GPU"
        description={gpu?.name ?? (system.isLoading ? "Reading device…" : "No GPU reported")}
        action={
          <Link to="/engines" className="text-[12.5px] font-medium text-fire hover:underline">
            Engines
          </Link>
        }
      />
      <CardBody className="flex flex-1 flex-col gap-4">
        {system.isLoading ? (
          <div className="flex items-center gap-4">
            <Skeleton className="size-[88px] rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-5">
            <VramRing used={used} total={total} />
            <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-muted">In use</dt>
              <dd className="font-medium tabular text-ink">
                {fmtGB(used)} <span className="text-faint">of {fmtGB(total)}</span>
              </dd>
              <dt className="text-muted">Default</dt>
              <dd className="truncate font-medium text-ink">{s?.default_engine ?? "–"}</dd>
              <dt className="text-muted">ASR</dt>
              <dd className="flex items-center gap-1.5 truncate font-medium text-ink">
                <Ear className="size-3.5 text-muted" />
                <span className="truncate">{s?.asr.model ?? "–"}</span>
                <span className={cn("size-1.5 rounded-full", s?.asr.loaded ? "bg-ok" : "bg-faint")} aria-label={s?.asr.loaded ? "loaded" : "not loaded"} />
              </dd>
            </dl>
          </div>
        )}

        <div>
          <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Loaded engines</p>
          {s && s.loaded_engines.length === 0 ? (
            <p className="text-[13px] text-muted">Nothing loaded. An engine loads on its first render.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {s?.loaded_engines.map((name) => {
                const busy = unload.isPending && unload.variables === name;
                return (
                  <Badge key={name} tone="ok" className="h-7 pr-1 pl-2.5">
                    <Cpu className="size-3" />
                    {name}
                    <Tooltip content={`Unload ${name}`}>
                      <button
                        type="button"
                        aria-label={`Unload ${name}`}
                        disabled={busy}
                        onClick={() => unload.mutate(name)}
                        className="ml-0.5 flex size-5 items-center justify-center rounded-full hover:bg-ok/15 disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
                      </button>
                    </Tooltip>
                  </Badge>
                );
              })}
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
