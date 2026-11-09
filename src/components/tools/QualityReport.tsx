import { useState } from "react";
import { Gauge } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { errMessage, useVoices } from "@/lib/api/hooks";
import type { QualityReport } from "@/lib/api/types";
import { Badge, Button, Card, NativeSelect } from "@/components/ui";
import { cn } from "@/lib/utils";

function Score({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2" title={hint}>
      <div className="text-[11px] font-semibold tracking-[0.06em] text-faint uppercase">{label}</div>
      <div className="mt-0.5 text-[16px] font-semibold text-ink tabular">{value}</div>
    </div>
  );
}

/** A quality report: DNSMOS scores, similarity to the voice, and the drift strip over the take. */
export function QualityView({ r }: { r: QualityReport }) {
  const d = r.drift;
  const flagged = new Set(d.flags.map((f) => f.start));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge tone={r.verdict === "good" ? "ok" : "warn"}>{r.verdict}</Badge>
        <span className="text-[12.5px] text-muted">{r.duration}s</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {r.mos && (
          <>
            <Score label="Overall" value={r.mos.overall} hint="DNSMOS: predicted listener score, 1-5" />
            <Score label="Speech" value={r.mos.signal} hint="DNSMOS signal quality" />
            <Score label="Background" value={r.mos.background} hint="DNSMOS background (higher = quieter)" />
            <Score label="P.808" value={r.mos.p808} />
          </>
        )}
        {r.similarity && (
          <Score
            label="Sounds like the voice"
            value={
              <>
                {r.similarity.value} <span className="text-[12px] font-normal text-muted">{r.similarity.same_speaker ? "same speaker" : "different"}</span>
              </>
            }
            hint={`${r.similarity.backend}; same speaker from about ${r.similarity.backend === "wavlm" ? "0.86" : "0.72"}`}
          />
        )}
        {d.windows.length > 0 && <Score label="Lowest window" value={`${d.min_similarity}`} hint={`compared with ${d.compared_with}`} />}
      </div>
      {d.windows.length > 1 && (
        <div className="flex h-12 items-end gap-0.5 rounded-lg bg-surface-2 p-1.5" aria-label="Voice similarity per window">
          {d.windows.map((w) => (
            <div
              key={w.start}
              title={`${w.start}-${w.end}s: similarity ${w.similarity}${w.f0 ? `, ${Math.round(w.f0)} Hz` : ""}, ${w.level_db} dB`}
              className={cn("min-w-[3px] flex-1 rounded-sm", flagged.has(w.start) ? "bg-warn" : "bg-ok/80")}
              style={{ height: `${Math.max(8, Math.round((100 * Math.max(0, (w.similarity ?? 0) - 0.5)) / 0.5))}%` }}
            />
          ))}
        </div>
      )}
      {d.flags.map((f) => (
        <p key={f.start} className="text-[12.5px] text-warn">
          {Math.round(f.start)}-{Math.round(f.end)}s: {f.why.join("; ")}
        </p>
      ))}
      {r.notes.map((n) => (
        <p key={n} className="text-[12.5px] text-muted">
          · {n}
        </p>
      ))}
    </div>
  );
}

/** Check any file: upload, optionally pick the voice it should sound like. */
export function QualityCheck() {
  const voices = useVoices();
  const [file, setFile] = useState<File | null>(null);
  const [voice, setVoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<QualityReport | null>(null);

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      setR(await api.qualityReport(file, voice || undefined));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <h3 className="text-[14px] font-semibold text-ink">Quality report</h3>
      <p className="mt-1 text-[12.5px] text-muted">Does it sound like the voice, how clean is it, and does the voice wander over a long take?</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept="audio/*,video/*"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setR(null);
          }}
          className="min-w-0 flex-1 text-[12.5px] text-ink-2 file:mr-3 file:rounded-md file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-ink"
        />
        <NativeSelect value={voice} onChange={(e) => setVoice(e.target.value)} className="w-auto" aria-label="Compare with voice">
          <option value="">Compare with no voice</option>
          {(voices.data ?? []).map((v) => (
            <option key={v.voice_id} value={v.voice_id}>
              {v.name || v.voice_id}
            </option>
          ))}
        </NativeSelect>
        <Button size="sm" variant="soft" leading={<Gauge className="size-4" />} disabled={!file} loading={busy} onClick={run}>
          Check
        </Button>
      </div>
      {r && (
        <div className="mt-4">
          <QualityView r={r} />
        </div>
      )}
    </Card>
  );
}
