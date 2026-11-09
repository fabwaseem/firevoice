import { useNavigate } from "react-router";
import { AudioLines, BookOpen } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, Skeleton } from "@/components/ui";
import { useHealth, useSystem } from "@/lib/api/hooks";
import { useSettings } from "@/stores/settings";
import { fmtGB } from "@/lib/utils";
import { greeting, openExternal } from "@/lib/external";
import { OfflineCard } from "@/components/home/OfflineCard";
import { QuickSpeakCard } from "@/components/home/QuickSpeakCard";
import { GpuCard } from "@/components/home/GpuCard";
import { RecentRendersCard } from "@/components/home/RecentRendersCard";
import { VoicesCard } from "@/components/home/VoicesCard";
import { StylesCard } from "@/components/home/StylesCard";

function Summary() {
  const system = useSystem();
  const s = system.data;
  if (!s) return <Skeleton className="mt-1 h-4 w-96 max-w-full" />;
  const gpu = s.gpu;
  const parts = [
    `${s.loaded_engines.length} ${s.loaded_engines.length === 1 ? "engine" : "engines"} loaded`,
    `${s.voices} ${s.voices === 1 ? "voice" : "voices"}`,
    `${s.styles} styles`,
  ];
  if (gpu?.name) parts.push(`${gpu.name}, ${fmtGB(gpu.vram_free_gb)} of ${fmtGB(gpu.vram_total_gb)} free`);
  return <>{parts.join(" · ")}</>;
}

export function HomeView() {
  const health = useHealth();
  const serverUrl = useSettings((s) => s.serverUrl);
  const navigate = useNavigate();
  const online = health.isSuccess;

  return (
    <div className="mx-auto max-w-[1400px] fade-up">
      <PageHeader
        title={greeting()}
        subtitle={online ? <Summary /> : health.isLoading ? "Connecting to the server…" : "Server offline"}
        actions={
          <>
            <Button variant="ghost" size="sm" leading={<BookOpen className="size-4" />} onClick={() => void openExternal(`${serverUrl}/docs`)}>
              API docs
            </Button>
            <Button variant="primary" size="sm" leading={<AudioLines className="size-4" />} onClick={() => navigate("/speak")}>
              New render
            </Button>
          </>
        }
      />

      {health.isError ? (
        <OfflineCard onRetry={() => void health.refetch()} retrying={health.isFetching} />
      ) : (
        <div className="grid grid-cols-12 gap-4">
          <section className="col-span-12 lg:col-span-7" aria-label="Quick speak">
            <QuickSpeakCard />
          </section>
          <section className="col-span-12 lg:col-span-5" aria-label="GPU">
            <GpuCard />
          </section>
          <section className="col-span-12 lg:col-span-7" aria-label="Recent renders">
            <RecentRendersCard />
          </section>
          <div className="col-span-12 flex flex-col gap-4 lg:col-span-5">
            <section aria-label="Voices">
              <VoicesCard />
            </section>
            <section aria-label="Styles">
              <StylesCard />
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
