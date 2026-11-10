import type { EngineParam } from "@/lib/api/types";

/** "top_p" -> "Top p" for settings without a label. */
function humanise(name: string): string {
  const s = name.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : name;
}

function fmtDefault(p: EngineParam): string {
  const d = p.default;
  if (d == null) return "–";
  if (Array.isArray(d)) return `[${d.join(", ")}]`;
  if (typeof d === "boolean") return d ? "on" : "off";
  return String(d);
}

function fmtRange(p: EngineParam): string | null {
  if (p.type === "enum" && p.choices?.length) return p.choices.join(" · ");
  if (p.type === "vector") return `${p.length ?? "n"} values${p.labels?.length ? `: ${p.labels.join(", ")}` : ""}`;
  if (p.min != null || p.max != null) return `${p.min ?? "…"} to ${p.max ?? "…"}${p.step != null ? ` by ${p.step}` : ""}`;
  return null;
}

/** Read-only listing of an engine's settings schema. */
export function ParamSchema({ params }: { params: EngineParam[] }) {
  return (
    <ul className="mt-4 divide-y divide-line border-t border-line">
      {params.map((p) => {
        const range = fmtRange(p);
        return (
          <li key={p.name} className="py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] font-medium text-ink">{p.label ?? humanise(p.name)}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-4 text-[12.5px] text-muted">
              <span>
                Default <span className="text-ink-2 tabular">{fmtDefault(p)}</span>
              </span>
              {range && <span className="truncate">{range}</span>}
            </div>
            {p.help && <p className="mt-0.5 text-[12.5px] text-muted">{p.help}</p>}
          </li>
        );
      })}
    </ul>
  );
}
