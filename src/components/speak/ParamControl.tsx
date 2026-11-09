import type { EngineParam } from "@/lib/api/types";
import { Input, LabeledSlider, Select, Slider, Switch } from "@/components/ui";

/** Renders one engine setting from its schema entry. */
export function ParamControl({ p, value, onChange }: { p: EngineParam; value: unknown; onChange: (v: unknown) => void }) {
  const label = p.label || p.name;
  const v = value ?? p.default;
  const isDefault = value === undefined || JSON.stringify(value) === JSON.stringify(p.default);
  const reset = isDefault ? undefined : () => onChange(undefined);

  switch (p.type) {
    case "float":
    case "int": {
      const min = p.min ?? 0;
      const max = p.max ?? (p.type === "int" ? 100 : 1);
      const step = p.step ?? (p.type === "int" ? 1 : 0.01);
      return (
        <LabeledSlider
          label={label}
          hint={p.help}
          value={Number(v)}
          min={min}
          max={max}
          step={step}
          onChange={(n) => onChange(p.type === "int" ? Math.round(n) : Number(n.toFixed(4)))}
          onReset={reset}
        />
      );
    }
    case "bool":
      return <Switch checked={Boolean(v)} onChange={onChange} label={label} description={p.help} />;
    case "enum":
      return (
        <div>
          <div className="mb-1 text-[13px] font-medium text-ink-2" title={p.help}>{label}</div>
          <Select size="sm" value={String(v)} onChange={onChange} options={(p.choices ?? []).map((c) => ({ value: c, label: c }))} ariaLabel={label} />
        </div>
      );
    case "vector": {
      const arr = Array.isArray(v) ? (v as number[]) : Array.from({ length: p.length ?? 0 }, () => 0);
      return (
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[13px] font-medium text-ink-2" title={p.help}>{label}</span>
            {reset && <button type="button" onClick={reset} className="text-[11px] text-faint hover:text-fire">reset</button>}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {arr.map((x, i) => (
              <label key={i} className="flex items-center gap-2 text-[12px] text-muted">
                <span className="w-20 truncate">{p.labels?.[i] ?? i + 1}</span>
                <Slider value={x} min={p.min ?? 0} max={p.max ?? 1} step={p.step ?? 0.05} ariaLabel={`${label} ${p.labels?.[i] ?? i + 1}`}
                  onChange={(n) => onChange(arr.map((y, j) => (j === i ? n : y)))} />
              </label>
            ))}
          </div>
        </div>
      );
    }
    default:
      return (
        <div>
          <div className="mb-1 text-[13px] font-medium text-ink-2" title={p.help}>{label}</div>
          <Input value={String(v ?? "")} onChange={(e) => onChange(e.target.value)} aria-label={label} />
        </div>
      );
  }
}
