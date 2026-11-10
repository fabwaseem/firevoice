import { useMemo } from "react";
import { Cpu } from "lucide-react";
import { useEngines, useSystem, errMessage } from "@/lib/api/hooks";
import { fmtGB } from "@/lib/utils";
import { PageHeader, LoadError } from "@/components/shell/PageHeader";
import { Badge, EmptyState, Skeleton } from "@/components/ui";
import { EngineCard } from "@/components/engines/EngineCard";

const GROUPS = [
  { task: "tts", title: "Speech" },
  { task: "sfx", title: "Sound effects and music" },
  { task: "vc", title: "Voice changer" },
  { task: "tool", title: "Audio tools" },
] as const;

export function EnginesView() {
  const engines = useEngines("all");
  const system = useSystem();
  const gpu = system.data?.gpu;

  const sorted = useMemo(() => {
    const rank = (e: { loaded: boolean; ready: boolean }) => (e.loaded ? 0 : e.ready ? 1 : 2);
    return [...(engines.data ?? [])].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
  }, [engines.data]);

  const loaded = sorted.filter((e) => e.loaded).length;
  const ready = sorted.filter((e) => e.ready).length;

  const subtitle = gpu?.name ? (
    <>
      {gpu.name}
      {gpu.vram_total_gb != null && gpu.vram_free_gb != null && (
        <>
          {" "}· <span className="tabular">{fmtGB(gpu.vram_free_gb)}</span> free of <span className="tabular">{fmtGB(gpu.vram_total_gb)}</span> GPU memory
        </>
      )}
    </>
  ) : (
    "All the voice engines FireVoice can use on this computer."
  );

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Engines"
        subtitle={subtitle}
        actions={
          engines.isSuccess && (
            <div className="flex gap-2">
              <Badge tone="ok" dot>
                {loaded} loaded
              </Badge>
              <Badge tone="info" dot>
                {ready} of {sorted.length} installed
              </Badge>
            </div>
          )
        }
      />

      {engines.isError ? (
        <LoadError message={errMessage(engines.error)} retry={() => void engines.refetch()} />
      ) : engines.isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4" aria-busy="true" aria-label="Loading engines">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="surface space-y-3 rounded-2xl p-5">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
              <div className="flex gap-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
              <Skeleton className="h-12 w-full" />
            </div>
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState icon={<Cpu />} title="No engines reported" description="The server returned an empty engine list." />
      ) : (
        <div className="space-y-8">
          {GROUPS.map(({ task, title }) => {
            const list = sorted.filter((e) => (e.task ?? "tts") === task);
            if (!list.length) return null;
            return (
              <section key={task}>
                <h2 className="mb-3 text-[12px] font-semibold tracking-[0.08em] text-faint uppercase">{title}</h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
                  {list.map((e) => (
                    <EngineCard key={e.name} engine={e} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
