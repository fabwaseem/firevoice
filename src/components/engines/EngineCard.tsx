import { useState } from "react";
import { useNavigate } from "react-router";
import { AudioLines, ChevronDown, Download, Power, PowerOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { Engine } from "@/lib/api/types";
import { useLoadEngine, useUnloadEngine } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { useStudio } from "@/stores/studio";
import { Badge, Button, Card, Tooltip } from "@/components/ui";
import { InstallPanel } from "./InstallPanel";
import { ParamSchema } from "./ParamSchema";

export function EngineCard({ engine }: { engine: Engine }) {
  const navigate = useNavigate();
  const setStudio = useStudio((s) => s.set);
  const load = useLoadEngine();
  const unload = useUnloadEngine();
  const [schemaOpen, setSchemaOpen] = useState(false);

  const langs = engine.languages.includes("*") ? "Many languages" : `${engine.languages.length} language${engine.languages.length === 1 ? "" : "s"}`;
  // the model behind the name and its licence, on hover only (the licences ask for credit)
  const credit = [engine.model, engine.license && `licence ${engine.license}`].filter(Boolean).join(" · ") || undefined;
  const busy = (engine.active_requests ?? 0) > 0;
  const loading = load.isPending && load.variables?.name === engine.name;

  return (
    <Card className={cn("flex flex-col rounded-2xl p-5 transition-shadow hover:shadow-md", !engine.ready && "opacity-80")}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="truncate text-[16px] font-semibold tracking-[-0.01em] text-ink" title={credit}>{engine.title}</h3>
        <StatusBadge engine={engine} />
      </div>
      {engine.tagline && <p className="mt-1 text-[13px] leading-relaxed text-muted">{engine.tagline}</p>}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {engine.tier && engine.tier.quality !== "-" && (
          <>
            <Badge tone={engine.tier.quality === "Studio" ? "fire" : "neutral"}>{engine.tier.quality}</Badge>
            <Badge tone="neutral">Size {engine.tier.size}</Badge>
            <Badge tone="neutral">{engine.tier.speed}</Badge>
          </>
        )}
        {engine.clone && <Badge tone="neutral">Clones voices</Badge>}
        {engine.design && <Badge tone="neutral">Designs voices</Badge>}
        {engine.task !== "sfx" && engine.task !== "tool" && <Badge tone="neutral">{langs}</Badge>}
      </div>

      <InstallPanel engine={engine} />

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {engine.loaded ? (
          <Tooltip content={busy ? "Busy with requests; wait for them to finish" : "Free its VRAM"}>
            <span>
              <Button size="sm" leading={<PowerOff className="size-4" />} disabled={busy} loading={unload.isPending && unload.variables === engine.name} onClick={() => unload.mutate(engine.name)}>
                Unload
              </Button>
            </span>
          </Tooltip>
        ) : (
          <Button
            size="sm"
            variant="soft"
            leading={<Power className="size-4" />}
            disabled={!engine.ready}
            loading={loading}
            onClick={() => load.mutate({ name: engine.name })}
          >
            {loading ? "Loading…" : "Load"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          leading={<AudioLines className="size-4" />}
          disabled={!engine.ready}
          onClick={() => {
            setStudio({ engine: engine.name, params: {} });
            navigate("/speak");
          }}
        >
          Use in Speak
        </Button>
        {engine.params.length > 0 && (
          <button
            type="button"
            aria-expanded={schemaOpen}
            onClick={() => setSchemaOpen((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-ink"
          >
            Settings
            <ChevronDown className={cn("size-4 transition-transform", schemaOpen && "rotate-180")} />
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {schemaOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
            className="overflow-hidden"
          >
            <ParamSchema params={engine.params} />
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

function StatusBadge({ engine }: { engine: Engine }) {
  if (engine.loaded) {
    return (
      <Badge tone="ok" className="shrink-0">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
        Loaded · {engine.workers ?? 1} worker{(engine.workers ?? 1) === 1 ? "" : "s"}
        {(engine.active_requests ?? 0) > 0 && ` · ${engine.active_requests} active`}
      </Badge>
    );
  }
  if (engine.ready) return <Badge tone="info" dot className="shrink-0">Ready</Badge>;
  return (
    <Badge tone="neutral" className="shrink-0">
      <Download className="size-3" />
      Not installed
    </Badge>
  );
}
