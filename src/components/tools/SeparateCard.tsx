import { useState } from "react";
import { Download, Layers } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { errMessage } from "@/lib/api/hooks";
import { saveBlob } from "@/lib/audio";
import { Button, Card, NativeSelect } from "@/components/ui";

type Mode = "vocals" | "denoise" | "dereverb";
const REST: Record<Mode, string> = { vocals: "music and effects", denoise: "noise", dereverb: "room echo" };

/** Pull a voice out of music and effects, noise or room echo (the separator engine). */
export function SeparateCard() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<Mode>("vocals");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ voice: Blob; rest: Blob; vUrl: string; rUrl: string } | null>(null);

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const [voice, rest] = await Promise.all([api.separate(file, mode, "voice"), api.separate(file, mode, "rest")]);
      setOut({ voice, rest, vUrl: URL.createObjectURL(voice), rUrl: URL.createObjectURL(rest) });
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <h3 className="text-[14px] font-semibold text-ink">Separate voice and music</h3>
      <p className="mt-1 text-[12.5px] text-muted">Pull a voice out of music and effects, noise or room echo. Needs the voice separator from Engines.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept="audio/*,video/*"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setOut(null);
          }}
          className="min-w-0 flex-1 text-[12.5px] text-ink-2 file:mr-3 file:rounded-md file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-ink"
        />
        <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as Mode)} className="w-auto" aria-label="What to separate">
          <option value="vocals">Voice | music and effects</option>
          <option value="denoise">Voice | noise</option>
          <option value="dereverb">Voice | room echo</option>
        </NativeSelect>
        <Button size="sm" variant="soft" leading={<Layers className="size-4" />} disabled={!file} loading={busy} onClick={run}>
          Separate
        </Button>
      </div>
      {out && (
        <div className="mt-4 space-y-3 text-[12.5px]">
          <div>
            <div className="mb-1 flex items-center justify-between text-muted">
              Voice
              <Button size="sm" variant="ghost" leading={<Download className="size-3.5" />} onClick={() => void saveBlob(out.voice, "voice.mp3")}>
                Save
              </Button>
            </div>
            <audio controls src={out.vUrl} className="w-full" />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-muted">
              The {REST[mode]}
              <Button size="sm" variant="ghost" leading={<Download className="size-3.5" />} onClick={() => void saveBlob(out.rest, `${REST[mode].split(" ")[0]}.mp3`)}>
                Save
              </Button>
            </div>
            <audio controls src={out.rUrl} className="w-full" />
          </div>
        </div>
      )}
    </Card>
  );
}
