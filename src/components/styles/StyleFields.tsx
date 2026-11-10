import type { ReactNode } from "react";
import { Input, Label, LabeledSlider, Textarea } from "@/components/ui";
import { TagsInput } from "./TagsInput";
import { EMO_LABELS, SLIDERS, type StyleDraft } from "./helpers";

type Patch = (p: Partial<StyleDraft>) => void;

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface-2/60 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        {hint && <span className="text-[12px] text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function TextFields({ draft, patch, readOnly }: { draft: StyleDraft; patch: Patch; readOnly: boolean }) {
  return (
    <Section title="Identity">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="st-title">Title</Label>
          <Input id="st-title" value={draft.title} disabled={readOnly} onChange={(e) => patch({ title: e.target.value })} placeholder="Display name" />
        </div>
        <div>
          <Label htmlFor="st-desc">Description</Label>
          <Input id="st-desc" value={draft.description} disabled={readOnly} onChange={(e) => patch({ description: e.target.value })} placeholder="When to use this style" />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="st-instruct" hint="instruction-following engines">
            Delivery instruction
          </Label>
          <Textarea id="st-instruct" value={draft.instruct} disabled={readOnly} onChange={(e) => patch({ instruct: e.target.value })} placeholder="speak softly, like a late-night radio host" className="min-h-[72px]" />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="st-vdesc" hint="appended to designed voices">
            Voice description suffix
          </Label>
          <Input id="st-vdesc" value={draft.desc} disabled={readOnly} onChange={(e) => patch({ desc: e.target.value })} placeholder="e.g. hushed and breathy" />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="st-tags" hint="hints for writers">
            Suggested inline tags
          </Label>
          <TagsInput id="st-tags" value={draft.tags} disabled={readOnly} onChange={(tags) => patch({ tags })} placeholder="[laugh], [sigh], [pause 400ms]…" />
        </div>
      </div>
    </Section>
  );
}

export function SliderFields({ draft, patch, readOnly, base }: { draft: StyleDraft; patch: Patch; readOnly: boolean; base?: StyleDraft }) {
  const groups: { id: "delivery" | "sampling" | "engine"; title: string; hint: string }[] = [
    { id: "delivery", title: "Delivery", hint: "tempo and pauses" },
    { id: "sampling", title: "Sampling", hint: "all engines" },
    { id: "engine", title: "Engine-specific", hint: "ignored by engines without the knob" },
  ];
  return (
    <>
      {groups.map((g) => (
        <Section key={g.id} title={g.title} hint={g.hint}>
          <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
            {SLIDERS.filter((s) => s.group === g.id).map((s) => (
              <LabeledSlider
                key={s.key}
                label={s.label}
                hint={s.hint}
                value={draft[s.key]}
                min={s.min}
                max={s.max}
                step={s.step}
                disabled={readOnly}
                onChange={(v) => patch({ [s.key]: v } as Partial<StyleDraft>)}
                onReset={!readOnly && base && base[s.key] !== draft[s.key] ? () => patch({ [s.key]: base[s.key] } as Partial<StyleDraft>) : undefined}
                format={(v) => v.toFixed(2)}
              />
            ))}
          </div>
        </Section>
      ))}
    </>
  );
}

export function EmotionFields({ draft, patch, readOnly }: { draft: StyleDraft; patch: Patch; readOnly: boolean }) {
  const setEmo = (i: number, v: number) => {
    const next = [...draft.emo_vector];
    next[i] = v;
    patch({ emo_vector: next });
  };
  const any = draft.emo_vector.some((v) => v > 0);
  return (
    <Section title="Emotion vector" hint={any ? "Firebrand and Firestorm" : "unset — engine default"}>
      <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
        {EMO_LABELS.map((label, i) => (
          <LabeledSlider key={label} label={label[0].toUpperCase() + label.slice(1)} value={draft.emo_vector[i] ?? 0} min={0} max={1} step={0.05} disabled={readOnly} onChange={(v) => setEmo(i, v)} format={(v) => v.toFixed(2)} />
        ))}
      </div>
    </Section>
  );
}

export function SampleField({ draft, patch, readOnly }: { draft: StyleDraft; patch: Patch; readOnly: boolean }) {
  return (
    <Section title="Showcase paragraph" hint="used by “Try it” and firevoice samples">
      <Textarea aria-label="Showcase paragraph" value={draft.sample} disabled={readOnly} onChange={(e) => patch({ sample: e.target.value })} className="min-h-[96px]" placeholder="A paragraph that shows this style off." />
    </Section>
  );
}
