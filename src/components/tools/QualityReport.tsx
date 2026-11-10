import { Gauge } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { errMessage, useVoices } from "@/lib/api/hooks";
import type { QualityReport } from "@/lib/api/types";
import { Badge, Button, Card, NativeSelect } from "@/components/ui";
import { cn } from "@/lib/utils";
import { TrySample } from "@/components/tools/TrySample";
import { useSessionState } from "@/stores/session";
import { FilePick } from "@/components/tools/FilePick";

function Score({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2" title={hint}>
      <div className="text-[11px] font-semibold tracking-[0.06em] text-faint uppercase">{label}</div>
      <div className="mt-0.5 text-[16px] font-semibold text-ink tabular">{value}</div>
    </div>
  );
}

/** A 1-5 listener score in words: "Good (4.1 of 5)". */
function mosWords(v: number | null | undefined): React.ReactNode {
  if (v == null || !Number.isFinite(Number(v))) return "–";
  const n = Number(v);
  const word = n >= 3.5 ? "Good" : n >= 2.8 ? "Fair" : "Poor";
  return (
    <>
      {word} <span className="text-[12px] font-normal text-muted">{n.toFixed(1)} of 5</span>
    </>
  );
}

/** 0.87 -> "87%" */
const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(Number(v)) ? "–" : `${Math.round(Number(v) * 100)}%`);

/** A quality report: sound quality scores, how much it sounds like the voice, and how that holds over the take. */
export function QualityView({ r }: { r: QualityReport }) {
  const d = r.drift;
  const flagged = new Set(d.flags.map((f) => f.start));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge tone={r.verdict === "good" ? "ok" : "warn"}>{r.verdict === "good" ? "Sounds good" : "Worth a listen"}</Badge>
        <span className="text-[12.5px] text-muted">{r.duration}s</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {r.mos && (
          <>
            <Score label="Sound quality" value={mosWords(r.mos.overall)} hint="How a listener would likely rate it, from 1 to 5" />
            <Score label="Speech clarity" value={mosWords(r.mos.signal)} hint="How clear the voice itself sounds" />
            <Score label="Background" value={mosWords(r.mos.background)} hint="Higher means a quieter background" />
          </>
        )}
        {r.similarity && (
          <Score
            label="Voice match"
            value={
              <>
                {pct(r.similarity.value)} <span className="text-[12px] font-normal text-muted">{r.similarity.same_speaker ? "Same speaker" : "Different speaker"}</span>
              </>
            }
            hint="How much it sounds like the chosen voice"
          />
        )}
        {d.windows.length > 0 && <Score label="Weakest moment" value={pct(d.min_similarity)} hint="The part that sounds least like the voice" />}
      </div>
      {d.windows.length > 1 && (
        <div className="flex h-12 items-end gap-0.5 rounded-lg bg-surface-2 p-1.5" aria-label="Voice match over the recording">
          {d.windows.map((w) => (
            <div
              key={w.start}
              title={`${Math.round(w.start)}-${Math.round(w.end)}s: ${pct(w.similarity)} match`}
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
  const [file, setFile] = useSessionState<File | null>("tool.quality.file", null);
  const [voice, setVoice] = useSessionState("tool.quality.voice", "");
  const [busy, setBusy] = useSessionState("tool.quality.busy", false);
  const [r, setR] = useSessionState<QualityReport | null>("tool.quality.r", null);

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
      <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2"><Gauge className="size-4 shrink-0 text-fire" />Quality report</h3>
      <p className="mt-1 text-[12.5px] text-muted">Does it sound like the voice, how clean is it, and does the voice wander over a long take?</p>
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <FilePick
          className="min-w-[200px] flex-1"
          file={file}
          onFile={(f) => { setFile(f); setR(null); }}
          below={<TrySample name="speech.mp3" onFile={(f) => { setFile(f); setR(null); }} />}
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
