import { Gauge, Layers, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { SeparateTool } from "@/components/tools/SeparateCard";
import { QualityTool } from "@/components/tools/QualityReport";
import { WatermarkTool } from "@/components/tools/WatermarkCheck";
import { RecentHistory } from "@/components/history/HistoryList";
import { cn } from "@/lib/utils";
import { useSessionState } from "@/stores/session";

type ToolId = "separate" | "quality" | "detect";

const TOOLS: { id: ToolId; title: string; detail: string; icon: typeof Layers }[] = [
  { id: "separate", title: "Separate voice", detail: "Pull a voice out of music, noise or room echo", icon: Layers },
  { id: "quality", title: "Quality report", detail: "Score clarity, background and voice match", icon: Gauge },
  { id: "detect", title: "AI speech check", detail: "Find FireVoice's inaudible watermark", icon: ShieldCheck },
];

/** Audio tools: separate a voice, score a recording, check for the AI watermark. One tool open at a time. */
export function ToolsView() {
  const [tool, setTool] = useSessionState<ToolId>("tools.open", "separate");
  return (
    <div className="page-width">
      <PageHeader title="Tools" subtitle="Clean up, check and verify any recording." />
      <div role="tablist" aria-label="Tools" className="mb-4 grid gap-3 sm:grid-cols-3">
        {TOOLS.map((t) => {
          const on = t.id === tool;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={`tool-${t.id}`}
              onClick={() => setTool(t.id)}
              className={cn(
                "group flex items-center gap-3.5 rounded-2xl border p-4 text-left transition-colors duration-200",
                on ? "border-fire/40 bg-fire-soft" : "border-line bg-surface hover:border-line-strong",
              )}
            >
              <span
                className={cn(
                  "flex size-11 shrink-0 items-center justify-center rounded-xl transition-colors",
                  on ? "fire-gradient text-white" : "bg-surface-3 text-muted group-hover:text-ink",
                )}
              >
                <t.icon className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ink">{t.title}</span>
                <span className="block text-[12px] leading-snug text-muted">{t.detail}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div id={`tool-${tool}`} role="tabpanel" key={tool} className="tool-active-in">
        {tool === "separate" && <SeparateTool />}
        {tool === "quality" && <QualityTool />}
        {tool === "detect" && <WatermarkTool />}
      </div>
      {tool === "separate" && <RecentHistory kinds={["separate", "clean"]} title="Recent separations" limit={5} empty="Separated tracks are saved automatically and listed here." />}
    </div>
  );
}
