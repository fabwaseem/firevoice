import { ScanSearch, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { errMessage } from "@/lib/api/hooks";
import type { WatermarkResult } from "@/lib/api/types";
import { Badge, Button, Card } from "@/components/ui";
import { TrySample } from "@/components/tools/TrySample";
import { useSessionState } from "@/stores/session";

/** Is a file AI speech? Every FireVoice output carries an inaudible watermark; this finds it again. */
export function WatermarkCheck() {
  const [file, setFile] = useSessionState<File | null>("tool.watermark.file", null);
  const [busy, setBusy] = useSessionState("tool.watermark.busy", false);
  const [r, setR] = useSessionState<WatermarkResult | null>("tool.watermark.r", null);

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
    <Card className="p-5">
      <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2"><ShieldCheck className="size-4 shrink-0 text-fire" />Is it AI speech?</h3>
      <p className="mt-1 text-[12.5px] text-muted">Everything FireVoice makes carries an inaudible watermark that survives MP3 and editing. Check any file for it.</p>
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
        <TrySample name="speech.mp3" onFile={(f) => { setFile(f); setR(null); }} />
        {file && <span className="max-w-[180px] truncate text-[12px] text-faint" title={file.name}>{file.name}</span>}
        <Button size="sm" variant="soft" leading={<ScanSearch className="size-4" />} disabled={!file} loading={busy} onClick={check}>
          Check
        </Button>
      </div>
      {r && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
          {r.firevoice ? (
            <Badge tone="ok">Made by FireVoice{r.kind === "render" ? " · speech" : r.kind === "convert" ? " · voice changer" : ""}</Badge>
          ) : r.watermarked ? (
            <Badge tone="warn">AI watermark, not FireVoice's</Badge>
          ) : (
            <Badge>No watermark found</Badge>
          )}
          <span className="text-muted">
            {Math.round(r.probability * 100)}% of {r.seconds}s carries a mark
          </span>
        </div>
      )}
    </Card>
  );
}
