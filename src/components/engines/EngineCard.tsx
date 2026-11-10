import { useState, type ComponentType } from "react";
import { useNavigate } from "react-router";
import { AudioLines, ChevronDown, Download, Layers, MapPin, Music, Power, PowerOff, Repeat2, Waves } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { Engine } from "@/lib/api/types";
import { useLoadEngine, useUnloadEngine } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { useStudio } from "@/stores/studio";
import { setSession } from "@/stores/session";
import { Badge, Button, Card, Tooltip } from "@/components/ui";
import { InstallPanel } from "./InstallPanel";
import { ParamSchema } from "./ParamSchema";

type Use = { label: string; to: string; icon: ComponentType<{ className?: string }>; where: string[]; speak?: boolean };

/** Where an engine is used in the app, and the page its button opens (only speech engines go to Speak). */
function usage(engine: Engine): Use {
  if (engine.task === "vc") return { label: "Open Voice changer", to: "/changer", icon: Repeat2, where: ["Voice changer"] };
  if (engine.name === "musicgen") return { label: "Open Sound", to: "/sound", icon: Music, where: ["Sound (music)", "Dialogue music beds"] };
  if (engine.task === "sfx") return { label: "Open Sound", to: "/sound", icon: Waves, where: ["Sound (effects)", "Dialogue sound cues"] };
  if (engine.task === "tool")
    return { label: "Open Tools", to: "/tools", icon: Layers, where: ["Tools (separate voice)", "Clean a voice (Best)", "Dubbing (keep the music)"] };
  return { label: "Use in Speak", to: "/speak", icon: AudioLines, where: ["Speak", "Dialogue", "Projects", "Dubbing"], speak: true };
}

export function EngineCard({ engine }: { engine: Engine }) {
  const use = usage(engine);
  const navigate = useNavigate();
  const setStudio = useStudio((s) => s.set);
  const load = useLoadEngine();
  const unload = useUnloadEngine();
  const [schemaOpen, setSchemaOpen] = useState(false);

  const languages = engine.languages ?? [];
  const params = engine.params ?? [];
  const langs = languages.includes("*") ? "Many languages" : `${languages.length} language${languages.length === 1 ? "" : "s"}`;
  const busy = (engine.active_requests ?? 0) > 0;
  const loading = load.isPending && load.variables?.name === engine.name;

  return (
    <Card className={cn("flex flex-col rounded-2xl p-5 transition-shadow hover:shadow-md", !engine.ready && "opacity-80")}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="truncate text-[16px] font-semibold tracking-[-0.01em] text-ink">{engine.title}</h3>
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
        {engine.task !== "sfx" && engine.task !== "tool" && languages.length > 0 && <Badge tone="neutral">{langs}</Badge>}
      </div>

      <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted">
        <MapPin className="size-3.5 shrink-0 text-faint" />
        <span className="text-faint">Used in</span>
        {use.where.map((w, i) => (
          <span key={w} className="text-ink-2">
            {w}
            {i < use.where.length - 1 && <span className="text-faint">,</span>}
          </span>
        ))}
      </p>

      <InstallPanel engine={engine} />

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {engine.loaded ? (
          <Tooltip content={busy ? "Busy with requests; wait for them to finish" : "Free up its GPU memory"}>
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
          leading={<use.icon className="size-4" />}
          disabled={!engine.ready}
          onClick={() => {
            if (use.speak) setStudio({ engine: engine.name, params: {} });
            if (engine.name === "musicgen") setSession("sound.kind", "music", "sfx");
            if (engine.name === "audioldm2") setSession("sound.kind", "sfx", "sfx");
            navigate(use.to);
          }}
        >
          {use.label}
        </Button>
        {params.length > 0 && (
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
            <ParamSchema params={params} />
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
        Loaded
        {(engine.workers ?? 1) > 1 && ` · ${engine.workers} copies`}
        {(engine.active_requests ?? 0) > 0 && ` · ${engine.active_requests} busy`}
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
