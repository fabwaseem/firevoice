import { useState, type ComponentType } from "react";
import { useNavigate } from "react-router";
import { AudioLines, Download, Layers, Music, Power, PowerOff, Repeat2, SlidersHorizontal, Trash2, Waves } from "@/components/icons";
import { AnimatePresence, motion } from "motion/react";
import type { Engine } from "@/lib/api/types";
import { useLoadEngine, useUnloadEngine } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { useStudio } from "@/stores/studio";
import { setSession } from "@/stores/session";
import { Badge, Button, Card, Tooltip } from "@/components/ui";
import { InstallPanel } from "./InstallPanel";
import { ParamSchema } from "./ParamSchema";

type Use = { label: string; to: string; icon: ComponentType<{ className?: string }>; speak?: boolean };

/** The page an engine's main button opens (only speech engines go to Speak). */
function usage(engine: Engine): Use {
  if (engine.task === "vc") return { label: "Open Voice changer", to: "/changer", icon: Repeat2 };
  if (engine.name === "musicgen") return { label: "Make music", to: "/sound", icon: Music };
  if (engine.task === "sfx") return { label: "Make sounds", to: "/sound", icon: Waves };
  if (engine.task === "tool") return { label: "Open Tools", to: "/tools", icon: Layers };
  return { label: "Use in Speak", to: "/speak", icon: AudioLines, speak: true };
}

/** The engine in one line a person can read: how big and fast it is, what it does, how many languages. */
function facts(engine: Engine): string {
  const out: string[] = [];
  const t = engine.tier;
  if (t && t.quality !== "-") {
    if (t.size) out.push(`Size ${t.size}`);
    if (t.speed) out.push(t.speed);
  }
  if (engine.clone && engine.design) out.push("Clones and designs voices");
  else if (engine.clone) out.push("Clones voices");
  else if (engine.design) out.push("Designs voices");
  const langs = engine.languages ?? [];
  if (engine.task !== "sfx" && engine.task !== "tool" && langs.length) out.push(langs.includes("*") ? "Many languages" : `${langs.length} language${langs.length === 1 ? "" : "s"}`);
  return out.join(" · ");
}

export function EngineCard({ engine }: { engine: Engine }) {
  const use = usage(engine);
  const navigate = useNavigate();
  const setStudio = useStudio((s) => s.set);
  const load = useLoadEngine();
  const unload = useUnloadEngine();
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const params = engine.params ?? [];
  const blocked = engine.compat?.status === "no";
  const busy = (engine.active_requests ?? 0) > 0;
  const loading = load.isPending && load.variables?.name === engine.name;
  const quality = engine.tier && engine.tier.quality !== "-" ? engine.tier.quality : null;
  const line = facts(engine);

  return (
    <Card className={cn("flex flex-col rounded-2xl p-5 transition-shadow hover:shadow-md", engine.loaded && "ring-1 ring-ok/40", blocked && "opacity-75")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[16px] font-semibold tracking-[-0.01em] text-ink">{engine.title}</h3>
            {quality && <Badge tone={quality === "Studio" ? "fire" : "neutral"}>{quality}</Badge>}
          </div>
          {engine.tagline && <p className="mt-1 text-[13px] leading-relaxed text-muted">{engine.tagline}</p>}
        </div>
        <StatusBadge engine={engine} />
      </div>

      {line && <p className="mt-3 text-[12.5px] text-faint">{line}</p>}

      <InstallPanel engine={engine} removeOpen={removeOpen} setRemoveOpen={setRemoveOpen} />

      {engine.ready && !blocked && (
        <div className="mt-auto flex items-center gap-2 pt-5">
          <Button
            size="sm"
            variant="soft"
            leading={<use.icon className="size-4" />}
            onClick={() => {
              if (use.speak) setStudio({ engine: engine.name, params: {} });
              if (engine.name === "musicgen") setSession("sound.kind", "music", "sfx");
              if (engine.name === "audioldm2") setSession("sound.kind", "sfx", "sfx");
              navigate(use.to);
            }}
          >
            {use.label}
          </Button>
          {engine.loaded ? (
            <Tooltip content={busy ? "Busy with requests; wait for them to finish" : "Free up its memory"}>
              <span>
                <Button size="sm" variant="ghost" leading={<PowerOff className="size-4" />} disabled={busy} loading={unload.isPending && unload.variables === engine.name} onClick={() => unload.mutate(engine.name)}>
                  Unload
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Tooltip content="Load it now, so the first render starts at once">
              <span>
                <Button size="sm" variant="ghost" leading={<Power className="size-4" />} loading={loading} onClick={() => load.mutate({ name: engine.name })}>
                  {loading ? "Loading…" : "Load"}
                </Button>
              </span>
            </Tooltip>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            {params.length > 0 && (
              <Tooltip content={schemaOpen ? "Hide settings" : "Settings"}>
                <button
                  type="button"
                  aria-label="Settings"
                  aria-expanded={schemaOpen}
                  onClick={() => setSchemaOpen((v) => !v)}
                  className={cn("grid size-8 place-items-center rounded-full text-faint transition-colors hover:bg-surface-2 hover:text-ink", schemaOpen && "bg-surface-2 text-ink")}
                >
                  <SlidersHorizontal className="size-4" />
                </button>
              </Tooltip>
            )}
            {engine.installable && !engine.loaded && (
              <Tooltip content="Remove from this computer">
                <button type="button" aria-label="Remove engine" onClick={() => setRemoveOpen(true)} className="grid size-8 place-items-center rounded-full text-faint transition-colors hover:bg-bad/10 hover:text-bad">
                  <Trash2 className="size-4" />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      )}

      {blocked && engine.ready && engine.installable && (
        <button type="button" onClick={() => setRemoveOpen(true)} className="mt-3 inline-flex items-center gap-1.5 self-start text-[12px] text-faint hover:text-bad">
          <Trash2 className="size-3.5" /> Remove to free the space
        </button>
      )}

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
  if (engine.compat?.status === "no") return <Badge tone="warn" className="shrink-0">Can't run here</Badge>;
  if (engine.ready) return <Badge tone="info" dot className="shrink-0">Ready</Badge>;
  return (
    <Badge tone="neutral" className="shrink-0">
      <Download className="size-3" />
      Not installed
    </Badge>
  );
}
