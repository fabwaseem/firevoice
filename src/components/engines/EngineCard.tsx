import { useState } from "react";
import { useNavigate } from "react-router";
import { AudioLines, ChevronDown, Download, Power, PowerOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { Engine } from "@/lib/api/types";
import { useLoadEngine, useUnloadEngine } from "@/lib/api/hooks";
import { cn, fmtGB } from "@/lib/utils";
import { useStudio } from "@/stores/studio";
import { Badge, Button, Card, Input, Tooltip } from "@/components/ui";
import { ParamSchema } from "./ParamSchema";

function Capability({ on, children }: { on: boolean; children: React.ReactNode }) {
  if (!on) return null;
  return <Badge tone="neutral">{children}</Badge>;
}

function speedLabel(rtf: number | null | undefined): string | null {
  if (rtf == null) return null;
  if (rtf < 1) return `${(1 / rtf).toFixed(1)}× faster than realtime`;
  if (rtf === 1) return "realtime";
  return `${rtf.toFixed(2)}× slower than realtime`;
}

export function EngineCard({ engine }: { engine: Engine }) {
  const navigate = useNavigate();
  const setStudio = useStudio((s) => s.set);
  const load = useLoadEngine();
  const unload = useUnloadEngine();
  const [workers, setWorkers] = useState<number | "">("");
  const [schemaOpen, setSchemaOpen] = useState(false);

  const langs = engine.languages.includes("*") ? "Many languages" : `${engine.languages.length} language${engine.languages.length === 1 ? "" : "s"}`;
  const speed = speedLabel(engine.speed_rtf);
  const busy = (engine.active_requests ?? 0) > 0;
  const loading = load.isPending && load.variables?.name === engine.name;

  return (
    <Card className={cn("flex flex-col rounded-2xl p-5 transition-shadow hover:shadow-md", !engine.ready && "opacity-80")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">{engine.title}</h3>
          <p className="truncate font-mono text-[12px] text-muted">{engine.name}</p>
        </div>
        <StatusBadge engine={engine} />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {engine.license && <Badge tone={engine.commercial ? "ok" : "warn"}>{engine.license}</Badge>}
        {engine.commercial != null && <Badge tone={engine.commercial ? "ok" : "warn"}>{engine.commercial ? "commercial OK" : "non-commercial"}</Badge>}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Capability on={engine.clone}>Clone</Capability>
        <Capability on={engine.design}>Design</Capability>
        <Capability on={engine.instruct}>Instruct</Capability>
        <Capability on={engine.tags}>Tags</Capability>
        <Capability on={engine.needs_transcript}>Needs transcript</Capability>
        <Capability on={engine.presets.length > 0}>{engine.presets.length} presets</Capability>
        <Badge tone="neutral">{langs}</Badge>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-2 text-[12.5px]">
        <div>
          <dt className="text-faint">Sample rate</dt>
          <dd className="font-medium text-ink tabular">{(engine.sample_rate / 1000).toFixed(engine.sample_rate % 1000 ? 2 : 0)} kHz</dd>
        </div>
        <div>
          <dt className="text-faint">Speed</dt>
          <dd className="font-medium text-ink tabular" title={engine.speed_rtf != null ? `RTF ${engine.speed_rtf}` : undefined}>
            {speed ?? "–"}
          </dd>
        </div>
        <div>
          <dt className="text-faint">VRAM</dt>
          <dd className="font-medium text-ink tabular">{fmtGB(engine.vram_gb)}</dd>
        </div>
      </dl>

      {engine.notes && <p className="mt-3 text-[13px] leading-relaxed text-muted">{engine.notes}</p>}

      {!engine.ready && engine.problems.length > 0 && (
        <div className="mt-3 rounded-md bg-surface-2 px-3 py-2">
          {engine.problems.map((p) => (
            <p key={p} className="font-mono text-[11.5px] text-muted">
              {p}
            </p>
          ))}
          <p className="mt-1 text-[12px] text-faint">Install steps are in the FireVoice README under “Other engines”.</p>
        </div>
      )}

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
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="soft"
              leading={<Power className="size-4" />}
              disabled={!engine.ready}
              loading={loading}
              onClick={() => load.mutate({ name: engine.name, workers: workers === "" ? undefined : workers })}
            >
              {loading ? "Loading…" : "Load"}
            </Button>
            <Input
              type="number"
              min={1}
              max={8}
              placeholder="auto"
              aria-label={`Workers for ${engine.title}`}
              value={workers}
              disabled={!engine.ready || loading}
              onChange={(e) => setWorkers(e.target.value === "" ? "" : Math.max(1, Math.min(8, Number(e.target.value))))}
              className="h-8 w-[76px] text-[12.5px]"
              title="Model copies on the GPU (blank = VRAM-aware default)"
            />
          </div>
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
