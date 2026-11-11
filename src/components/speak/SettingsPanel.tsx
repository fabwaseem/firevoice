import { useState } from "react";
import { AudioWaveform, ChevronDown, Dices, FileAudio, Languages, MessageSquareText, Palette, RotateCcw } from "lucide-react";
import type { Engine, Style } from "@/lib/api/types";
import { useShallow } from "zustand/react/shallow";
import { useStudio } from "@/stores/studio";
import { useSettings } from "@/stores/settings";
import { Badge, Button, Label, LabeledSlider, Select, Switch, Textarea, Tooltip } from "@/components/ui";
import { cn, langName } from "@/lib/utils";
import { ParamControl } from "./ParamControl";
import { actsStyles, STYLE_ENGINE } from "@/lib/styles";

/** A collapsible group. Whether it is open is remembered (per section) across pages and restarts. */
function Section({ title, children, defaultOpen = false, right }: { title: string; children: React.ReactNode; defaultOpen?: boolean; right?: React.ReactNode }) {
  const key = `firevoice.speak.open.${title.toLowerCase()}`;
  const [open, setOpenState] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? defaultOpen : v === "1";
    } catch {
      return defaultOpen;
    }
  });
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      /* storage unavailable: the choice lasts this session */
    }
  };
  return (
    <section className="border-t border-line first:border-t-0">
      <div className="flex items-center justify-between py-3">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="-mx-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-fire/40">
          <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
          {title}
        </button>
        {right}
      </div>
      {open && <div className="space-y-4 pb-4">{children}</div>}
    </section>
  );
}

/** Right-hand rail: engine, delivery, quality and output settings for the Speak view. */
export function SettingsPanel({ engines, engine, style, disabled }: { engines: Engine[]; engine?: Engine; style?: Style; disabled?: boolean }) {
  const s = useStudio(
    useShallow((x) => ({
      engine: x.engine, params: x.params, pace: x.pace, language: x.language, instruct: x.instruct, candidates: x.candidates,
      validate: x.validate, keepTakes: x.keepTakes, accept: x.accept, seed: x.seed, sampleRate: x.sampleRate, lufs: x.lufs,
      leadMs: x.leadMs, tailMs: x.tailMs, set: x.set, resetParams: x.resetParams,
    })),
  );
  const showAdvanced = useSettings((x) => x.showAdvanced);
  const styleEngine = engines.find((e) => e.name === STYLE_ENGINE);
  const format = useSettings((x) => x.format);
  const setSettings = useSettings((x) => x.set);

  const engineOptions = engines.map((e) => ({
    value: e.name,
    label: e.title,
    description: [e.tier && e.tier.quality !== "-" ? `${e.tier.quality} · ${e.tier.size} · ${e.tier.speed}` : null,
      e.ready ? (e.loaded ? "Loaded" : null) : "Not installed"].filter(Boolean).join(" · "),
    disabled: !e.ready,
    group: e.ready ? "Installed" : "Not installed",
  }));
  const languages = engine?.languages?.includes("*") ? Object.keys({ en: 1, ur: 1, hi: 1, ar: 1, zh: 1, ja: 1, es: 1, fr: 1, de: 1 }) : (engine?.languages ?? []);

  return (
    <div className={cn("text-ink", disabled && "pointer-events-none opacity-60")}>
      <Section title="Engine" defaultOpen right={engine && (engine.loaded ? <Badge tone="ok" dot>Loaded</Badge> : <Badge>Loads on first use</Badge>)}>
        <Select value={s.engine ?? engine?.name ?? ""} onChange={(v) => s.set({ engine: v, params: {} })} options={engineOptions} placeholder="Default engine" ariaLabel="Engine" />
        {engine?.tagline && (
          <p className="-mt-2 text-[12px] leading-snug text-muted">
            {engine.tagline}
            {engine.tier && engine.tier.quality !== "-" && (
              <span className="text-faint"> · {engine.tier.quality} · size {engine.tier.size} · {engine.tier.speed}</span>
            )}
          </p>
        )}
        {engine && (engine.params ?? []).length > 0 && (
          <div className="space-y-4 rounded-xl bg-surface-2/70 p-3">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-ink-2">{engine.title} settings</span>
              {Object.keys(s.params).length > 0 && (
                <button type="button" onClick={s.resetParams} className="flex items-center gap-1 text-[11.5px] text-muted hover:text-fire">
                  <RotateCcw className="size-3" /> Defaults
                </button>
              )}
            </div>
            {(engine.params ?? []).map((p) => (
              <ParamControl key={p.name} p={p} value={s.params[p.name]} onChange={(v) => {
                const next = { ...s.params };
                if (v === undefined) delete next[p.name];
                else next[p.name] = v;
                s.set({ params: next });
              }} />
            ))}
          </div>
        )}
      </Section>

      {/* styles come with Firebrand: with another engine this section says how to get them */}
      {!actsStyles(engine) && (
        <Section title="Styles">
          <div className="flex items-start gap-3 rounded-xl bg-surface-2/60 px-3.5 py-3">
            <Palette className="mt-0.5 size-4 shrink-0 text-fire" />
            <div className="min-w-0 space-y-2">
              <p className="text-[12.5px] leading-relaxed text-muted">
                Delivery styles (excited, sad, whisper, newscaster…) work with <span className="font-medium text-ink-2">{styleEngine?.title ?? "Firebrand"}</span>.
                Choose it as the engine and a style picker appears above the script.
              </p>
              {styleEngine && (
                <Button size="sm" variant="outline" disabled={disabled} onClick={() => s.set({ engine: STYLE_ENGINE })}>
                  Use {styleEngine.title}
                </Button>
              )}
            </div>
          </div>
        </Section>
      )}

      <Section title="Delivery">
        <LabeledSlider label="Pace" value={s.pace} min={0.5} max={2} step={0.05} onChange={(pace) => s.set({ pace })} onReset={s.pace !== 1 ? () => s.set({ pace: 1 }) : undefined} hint="Tempo on top of the style's own pacing" />
        <div>
          <Label hint={languages.length ? `${languages.length} supported` : undefined} icon={<Languages />}>Language</Label>
          <Select size="sm" value={s.language ?? "auto"} onChange={(v) => s.set({ language: v === "auto" ? null : v })} ariaLabel="Language"
            options={[{ value: "auto", label: "Detect from script" }, ...languages.map((l) => ({ value: l, label: langName(l) }))]} />
        </div>
        {(engine?.instruct ?? true) && (
          <div>
            <Label hint={s.instruct === null ? "from style" : s.instruct === "" ? "none" : "custom"} icon={<MessageSquareText />}>Instruction</Label>
            <Textarea
              rows={3}
              value={s.instruct ?? style?.instruct ?? ""}
              onChange={(e) => s.set({ instruct: e.target.value })}
              placeholder="e.g. speak softly, like a late-night radio host"
              className="text-[13px]"
              aria-label="Delivery instruction"
            />
            {s.instruct !== null && (
              <button type="button" onClick={() => s.set({ instruct: null })} className="mt-1 text-[11.5px] text-muted hover:text-fire">
                Use the style's instruction
              </button>
            )}
          </div>
        )}
      </Section>

      <Section title="Quality" defaultOpen={showAdvanced}>
        <LabeledSlider label="Takes per sentence" value={s.candidates} min={1} max={8} step={1} onChange={(candidates) => s.set({ candidates })} hint="The take that best matches your script is kept" />
        <Switch checked={s.validate} onChange={(validate) => s.set({ validate })} label="Check every sentence by listening back" description="Records a sentence again when it doesn’t match the script" />
        <Switch checked={s.keepTakes} onChange={(keepTakes) => s.set({ keepTakes })} label="Keep every take" description="Compare, re-take and lock passages after a render" />
        {s.validate && <LabeledSlider label="How closely it must match" value={s.accept} min={0.5} max={1} step={0.01} onChange={(accept) => s.set({ accept })} />}
        <div>
          <Label icon={<Dices />}>Seed</Label>
          <div className="flex gap-2">
            <input type="number" value={s.seed} onChange={(e) => s.set({ seed: Number(e.target.value) || 0 })} aria-label="Seed"
              className="h-8 w-full rounded-md border border-line bg-surface-2 px-2.5 text-[13px] tabular focus:border-fire/60 focus:outline-none" />
            <Tooltip content="Random seed">
              <Button size="icon-sm" variant="outline" aria-label="Random seed" onClick={() => s.set({ seed: Math.floor(Math.random() * 1e6) })}>
                <Dices className="size-4" />
              </Button>
            </Tooltip>
          </div>
        </div>
      </Section>

      <Section title="Output" defaultOpen={showAdvanced}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label icon={<FileAudio />}>Format</Label>
            <Select size="sm" value={format} onChange={(v) => setSettings({ format: v as typeof format })} ariaLabel="Output format"
              options={["mp3", "wav", "flac", "ogg", "opus", "m4a"].map((f) => ({ value: f, label: f.toUpperCase() }))} />
          </div>
          <div>
            <Label icon={<AudioWaveform />}>Sample rate</Label>
            <Select size="sm" value={String(s.sampleRate ?? "native")} onChange={(v) => s.set({ sampleRate: v === "native" ? null : Number(v) })} ariaLabel="Sample rate"
              options={[{ value: "native", label: engine ? `Native ${engine.sample_rate / 1000} kHz` : "Native" }, ...[22050, 24000, 44100, 48000].map((r) => ({ value: String(r), label: `${r / 1000} kHz` }))]} />
          </div>
        </div>
        <Switch checked={s.lufs !== null} onChange={(on) => s.set({ lufs: on ? -16 : null })} label="Studio mastering" description="Evens out the loudness of the final file" />
        {s.lufs !== null && <LabeledSlider label="Loudness (LUFS)" value={s.lufs} min={-30} max={-9} step={1} onChange={(lufs) => s.set({ lufs })} />}
        <div className="grid grid-cols-2 gap-3">
          <LabeledSlider label="Silence before (ms)" value={s.leadMs} min={0} max={1000} step={10} onChange={(leadMs) => s.set({ leadMs })} />
          <LabeledSlider label="Silence after (ms)" value={s.tailMs} min={0} max={2000} step={10} onChange={(tailMs) => s.set({ tailMs })} />
        </div>
      </Section>
    </div>
  );
}
