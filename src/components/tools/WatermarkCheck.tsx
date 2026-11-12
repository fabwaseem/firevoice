import { FileCheck2, Repeat2, ScanSearch, ShieldAlert, ShieldCheck, ShieldQuestion, Scissors, AudioLines } from "@/components/icons";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { errMessage } from "@/lib/api/hooks";
import type { WatermarkResult } from "@/lib/api/types";
import { Button, ProgressBar } from "@/components/ui";
import { useSessionState } from "@/stores/session";
import { DropZone, ResultEmpty, ResultHeader, Step, ToolWorkspace, Working } from "./ToolLayout";

const FACTS = [
  { icon: AudioLines, text: "Every voice FireVoice makes carries a mark no one can hear." },
  { icon: Repeat2, text: "It survives MP3 and other formats, and changes in volume." },
  { icon: Scissors, text: "Edited and trimmed clips are still recognised." },
];

/** Is a file AI speech? Every FireVoice output carries an inaudible watermark; this finds it again. */
export function WatermarkTool() {
  const [file, setFile] = useSessionState<File | null>("tool.watermark.file", null);
  const [busy, setBusy] = useSessionState("tool.watermark.busy", false);
  const [r, setR] = useSessionState<WatermarkResult | null>("tool.watermark.r", null);

  const choose = (f: File | null) => {
    setFile(f);
    setR(null);
  };
  const check = async () => {
    if (!file) return;
    setBusy(true);
    try {
      setR(await api.detectWatermark(file));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ToolWorkspace
      input={
        <>
          <Step n={1} title="The file to check">
            <DropZone file={file} onFile={choose} sample="speech.mp3" disabled={busy} />
          </Step>
          <Step n={2} title="How it works">
            <ul className="space-y-2">
              {FACTS.map((f) => (
                <li key={f.text} className="flex items-start gap-2.5 text-[12.5px] text-muted">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-2">
                    <f.icon className="size-3.5" />
                  </span>
                  <span className="pt-0.5">{f.text}</span>
                </li>
              ))}
            </ul>
          </Step>
          <Button variant="primary" size="md" className="w-full" leading={<ScanSearch className="size-4" />} disabled={!file} loading={busy} onClick={check}>
            Check for AI speech
          </Button>
        </>
      }
      result={
        busy ? (
          <Working title="Listening for the watermark…" hint="A few seconds for most files." />
        ) : r ? (
          <Verdict r={r} />
        ) : (
          <ResultEmpty icon={<ShieldQuestion />} title="Was this voice made with AI?">
            Add any recording and FireVoice tells you whether it carries its watermark, or another AI watermark.
          </ResultEmpty>
        )
      }
    />
  );
}

function Verdict({ r }: { r: WatermarkResult }) {
  const share = Math.round(r.probability * 100);
  const made = r.kind === "render" ? "Speech (Speak, Dialogue, Projects)" : r.kind === "convert" ? "Voice changer" : null;
  return (
    <div className="tool-active-in space-y-5">
      {r.firevoice ? (
        <ResultHeader icon={<ShieldCheck />} tone="ok" title="Made by FireVoice" detail="This recording carries FireVoice's AI watermark." />
      ) : r.watermarked ? (
        <ResultHeader icon={<ShieldAlert />} tone="warn" title="AI watermark found" detail="It is marked as AI speech, but not by FireVoice." />
      ) : (
        <ResultHeader icon={<FileCheck2 />} title="No watermark found" detail="Nothing marks this as AI speech. Some AI voices carry no watermark at all." />
      )}
      <div className="space-y-2 rounded-xl border border-line p-4">
        <div className="flex items-baseline justify-between text-[12.5px]">
          <span className="font-medium text-ink-2">Marked audio</span>
          <span className="text-muted tabular">
            <b className="text-[15px] font-semibold text-ink">{share}%</b> of {r.seconds}s
          </span>
        </div>
        <ProgressBar value={r.probability} tone={r.firevoice || r.watermarked ? "ok" : "info"} />
      </div>
      {made && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl bg-surface-2 px-4 py-3 text-[12.5px]">
          <dt className="text-muted">Made with</dt>
          <dd className="font-medium text-ink">{made}</dd>
        </dl>
      )}
    </div>
  );
}
