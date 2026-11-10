import { useEffect, useMemo } from "react";
import { motion } from "motion/react";
import { AudioLines, Clock, Gauge, Layers, ListPlus, Radio, Repeat, Square, Zap } from "lucide-react";
import { useCreateJob, useEngines, useHealth, useOptions, useStyles, useEngineName } from "@/lib/api/hooks";
import type { TTSRequest } from "@/lib/api/types";
import { useStudio } from "@/stores/studio";
import { useSettings } from "@/stores/settings";
import { PageHeader } from "@/components/shell/PageHeader";
import { Badge, Button, Card, Label, ProgressBar, Segmented, Skeleton, Tooltip } from "@/components/ui";
import { ScriptEditor } from "@/components/speak/ScriptEditor";
import { VoicePicker } from "@/components/speak/VoicePicker";
import { StylePicker } from "@/components/speak/StylePicker";
import { SettingsPanel } from "@/components/speak/SettingsPanel";
import { ReadAlong } from "@/components/speak/ReadAlong";
import { useRender } from "@/components/speak/useRender";
import { TakesPanel, SubtitleButtons } from "@/components/speak/TakesPanel";
import { fmtDuration, truncate } from "@/lib/utils";

export function SpeakView() {
  const s = useStudio();
  const health = useHealth();
  const options = useOptions();
  const enginesQ = useEngines();
  const stylesQ = useStyles();
  const stream = useSettings((x) => x.streamByDefault);
  const format = useSettings((x) => x.format);
  const setSettings = useSettings((x) => x.set);
  const createJob = useCreateJob();
  const { state, busy, renderWhole, renderStream, stop, replaceResult } = useRender();

  const engines = enginesQ.data ?? options.data?.engines ?? [];
  const styles = stylesQ.data ?? options.data?.styles ?? [];
  const nameOf = useEngineName();
  const engineName = s.engine ?? options.data?.default_engine ?? null;
  const engine = engines.find((e) => e.name === engineName);
  const style = styles.find((x) => x.name === s.style);
  const offline = health.isError;

  // Drop params that the newly chosen engine doesn't know.
  useEffect(() => {
    if (!engine) return;
    const known = new Set(engine.params.map((p) => p.name));
    const extra = Object.keys(s.params).filter((k) => !known.has(k));
    if (extra.length) s.set({ params: Object.fromEntries(Object.entries(s.params).filter(([k]) => known.has(k))) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine?.name]);

  const request = useMemo<TTSRequest>(() => ({
    text: s.text,
    engine: s.engine,
    voice: s.voice,
    style: s.style,
    pace: s.pace,
    seed: s.seed,
    language: s.language,
    instruct: s.instruct,
    params: s.params,
    style_overrides: s.styleOverrides,
    candidates: s.candidates,
    accept: s.accept,
    validate: s.validate,
    lufs: s.lufs,
    lead_ms: s.leadMs,
    tail_ms: s.tailMs,
    format,
    sample_rate: s.sampleRate,
    keep_takes: s.keepTakes,
  }), [s, format]);

  const canRender = !!s.text.trim() && !offline && !busy;
  const go = () => (stream ? renderStream(request) : renderWhole(request));
  const queueJob = () => {
    const { format: f, sample_rate, ...req } = request;
    createJob.mutate({ kind: "tts", payload: { request: req, format: f, sample_rate }, title: truncate(s.text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim(), 60) });
  };

  // Ctrl/Cmd+Enter renders.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (canRender) go();
      } else if (e.key === "Escape" && busy) stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Speak"
        subtitle="Write a script, pick a voice and a delivery, and render it on your GPU."
        actions={
          <Segmented
            ariaLabel="Render mode"
            value={stream ? "stream" : "file"}
            onChange={(v) => setSettings({ streamByDefault: v === "stream" })}
            options={[
              { value: "stream", label: "Stream", icon: <Radio className="size-3.5" /> },
              { value: "file", label: "Whole file", icon: <Layers className="size-3.5" /> },
            ]}
          />
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Left: voice, style, script, render */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="p-4">
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
              <div>
                <Label>Voice</Label>
                <VoicePicker value={s.voice} onChange={(voice) => s.set({ voice })} engine={engine} disabled={busy} />
              </div>
              <div className="min-w-0">
                <Label hint={style?.builtin === false ? "custom" : undefined}>Style</Label>
                {stylesQ.isLoading && !styles.length ? (
                  <div className="flex gap-2"><Skeleton className="h-8 w-24 rounded-full" /><Skeleton className="h-8 w-20 rounded-full" /><Skeleton className="h-8 w-28 rounded-full" /></div>
                ) : (
                  <StylePicker styles={styles} value={s.style} onChange={(st) => s.set({ style: st, instruct: null })} disabled={busy} />
                )}
                <p className="mt-1.5 line-clamp-1 text-[12px] text-muted">{style?.description || style?.instruct || " "}</p>
              </div>
            </div>
          </Card>

          <Card raised className="flex min-h-[420px] flex-col p-4">
            <ScriptEditor supportsTags={!!engine?.tags} disabled={busy} className="flex-1" />
          </Card>

          {/* Render bar */}
          <div className="flex flex-wrap items-center gap-3">
            {busy ? (
              <Button size="lg" variant="secondary" onClick={stop} leading={<Square className="size-4 fill-current" />} className="min-w-44">
                Stop <span className="ml-1 text-[11px] opacity-60">Esc</span>
              </Button>
            ) : (
              <Tooltip content={stream ? "Hear it as each sentence finishes" : "Render the whole file, mastered"} shortcut="Ctrl ↵">
                <Button size="lg" variant="primary" onClick={go} disabled={!canRender} leading={<AudioLines className="size-[18px]" />} className="min-w-44">
                  {state.phase === "done" ? "Render again" : "Render"}
                </Button>
              </Tooltip>
            )}
            <Tooltip content="Queue as a background job; it is kept in Jobs history">
              <Button size="lg" variant="outline" onClick={queueJob} disabled={!s.text.trim() || offline} loading={createJob.isPending} leading={<ListPlus className="size-[18px]" />}>
                Render as job
              </Button>
            </Tooltip>
            <div className="min-w-0 flex-1">
              <RenderStatus phase={state.phase} got={state.chunksGot} total={state.chunksTotal} error={state.error} engineLoaded={!!engine?.loaded} />
            </div>
          </div>

          {(state.words.length > 0 || state.stats) && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
              {state.stats && (
                <div className="flex flex-wrap gap-2">
                  <Stat icon={<Clock className="size-3.5" />} label="Duration" value={fmtDuration(state.stats.duration)} />
                  {state.stats.seconds != null && <Stat icon={<Zap className="size-3.5" />} label="Rendered in" value={fmtDuration(state.stats.seconds)} />}
                  {state.stats.rtf != null && <Stat icon={<Gauge className="size-3.5" />} label="Speed" value={state.stats.rtf > 0 ? `${(1 / state.stats.rtf).toFixed(1)}× realtime` : "–"} />}
                  {state.stats.takes != null && <Stat icon={<Repeat className="size-3.5" />} label="Takes / retries" value={`${state.stats.takes} / ${state.stats.retries ?? 0}`} />}
                  {state.stats.engine && <Stat label="Engine" value={nameOf(state.stats.engine)} />}
                  {state.stats.warnings.map((w) => <Badge key={w} tone="warn">{w}</Badge>)}
                </div>
              )}
              <ReadAlong words={state.words} />
              {state.phase === "done" && <SubtitleButtons renderId={state.stats?.renderId ?? null} words={state.words} />}
              {state.phase === "done" && state.stats?.renderId && (
                <TakesPanel renderId={state.stats.renderId} format={format} onAudio={replaceResult} />
              )}
            </motion.div>
          )}
        </div>

        {/* Right: settings rail */}
        <Card className="h-fit px-4 py-1 lg:sticky lg:top-0">
          {enginesQ.isLoading && !engines.length ? (
            <div className="space-y-3 py-4"><Skeleton className="h-9" /><Skeleton className="h-24" /><Skeleton className="h-16" /></div>
          ) : (
            <SettingsPanel engines={engines} engine={engine} style={style} disabled={busy} />
          )}
        </Card>
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px]">
      {icon && <span className="text-muted">{icon}</span>}
      <span className="text-muted">{label}</span>
      <span className="font-semibold text-ink tabular">{value}</span>
    </span>
  );
}

function RenderStatus({ phase, got, total, error, engineLoaded }: { phase: string; got: number; total: number; error: string | null; engineLoaded: boolean }) {
  if (phase === "starting" || phase === "rendering") {
    return (
      <div className="flex items-center gap-3 text-[13px] text-muted">
        <span className="size-2 animate-pulse rounded-full bg-fire" />
        {engineLoaded ? (phase === "rendering" ? "Rendering every sentence in parallel…" : "Rendering the first sentence…") : "Loading the engine first. The first load can take a minute or two…"}
      </div>
    );
  }
  if (phase === "streaming") {
    return (
      <div className="flex items-center gap-3">
        <ProgressBar value={total ? got / total : 0} className="max-w-64" tone="ok" />
        <span className="text-[12.5px] text-muted tabular">{got} / {total} sentences</span>
      </div>
    );
  }
  if (phase === "error" && error) return <p className="truncate text-[13px] text-bad" title={error}>{error}</p>;
  return null;
}
