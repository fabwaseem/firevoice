import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, AudioWaveform, Building2, Layers, Mic2, Music, Wind } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { errMessage, useEngines } from "@/lib/api/hooks";
import { saveBlob } from "@/lib/audio";
import { AudioPlayer, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useReleaseOnReplace, useSessionState } from "@/stores/session";
import { DropZone, ResultEmpty, ResultHeader, Step, ToolWorkspace, Working } from "./ToolLayout";

type Mode = "vocals" | "denoise" | "dereverb";
const MODES: { value: Mode; label: string; detail: string; rest: string; icon: typeof Music }[] = [
  { value: "vocals", label: "Music and effects", detail: "Songs, trailers, videos with a soundtrack", rest: "Music and effects", icon: Music },
  { value: "denoise", label: "Background noise", detail: "Street, fans, hum and hiss", rest: "Background noise", icon: Wind },
  { value: "dereverb", label: "Room echo", detail: "Big rooms, halls, bathrooms", rest: "Room echo", icon: Building2 },
];

/** Pull a voice out of music and effects, noise or room echo (the Crucible engine). */
export function SeparateTool() {
  const [file, setFile] = useSessionState<File | null>("tool.separate.file", null);
  const [mode, setMode] = useSessionState<Mode>("tool.separate.mode", "vocals");
  const [busy, setBusy] = useSessionState("tool.separate.busy", false);
  const [out, setOut] = useSessionState<{ voice: Blob; vUrl: string; rUrl: string; rest?: Blob; mode: Mode; name: string } | null>("tool.separate.out", null);
  const engines = useEngines("all");
  const engine = (engines.data ?? []).find((e) => e.name === "separator");
  const missing = engines.isSuccess && !engine?.ready;
  const qc = useQueryClient();
  // object URLs made here are released when a new separation replaces them
  useReleaseOnReplace(out?.vUrl);
  useReleaseOnReplace(out?.rUrl);

  const choose = (f: File | null) => {
    setFile(f);
    setOut(null);
  };

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      // one separation: the voice comes back, both tracks are kept in History, the other track plays from there
      const r = await api.separate(file, mode, "voice");
      const base = { voice: r.blob, vUrl: URL.createObjectURL(r.blob), mode, name: file.name.replace(/\.[^.]+$/, "") };
      if (r.historyId) {
        setOut({ ...base, rUrl: api.historyAudioUrl({ id: r.historyId }, "rest") });
        void qc.invalidateQueries({ queryKey: ["history"] });
      } else {
        const rest = await api.separate(file, mode, "rest");
        setOut({ ...base, rest: rest.blob, rUrl: URL.createObjectURL(rest.blob) });
      }
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const m = MODES.find((x) => x.value === (out?.mode ?? mode))!;
  const saveRest = async () => {
    if (!out) return;
    const blob = out.rest ?? (await (await fetch(out.rUrl)).blob());
    void saveBlob(blob, `${out.name} - ${m.rest.toLowerCase()}.mp3`);
  };

  return (
    <ToolWorkspace
      input={
        <>
          <Step n={1} title="Your file">
            <DropZone file={file} onFile={choose} sample="speech-with-music.mp3" disabled={busy} />
          </Step>
          <Step n={2} title="Take the voice away from">
            <div role="radiogroup" aria-label="What to remove" className="grid gap-2 sm:grid-cols-3">
              {MODES.map((o) => {
                const on = o.value === mode;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={busy}
                    onClick={() => setMode(o.value)}
                    className={cn(
                      "flex flex-col items-start gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-60",
                      on ? "border-fire/60 bg-fire-soft" : "border-line bg-surface-2/60 hover:border-line-strong hover:bg-surface-2",
                    )}
                  >
                    <o.icon className={cn("size-4", on ? "text-fire" : "text-muted")} />
                    <span className="text-[13px] font-semibold text-ink">{o.label}</span>
                    <span className="text-[11.5px] leading-snug text-muted">{o.detail}</span>
                  </button>
                );
              })}
            </div>
          </Step>
          {missing && (
            <div className="flex items-start gap-2.5 rounded-xl bg-warn-soft px-3.5 py-3 text-[12.5px] text-warn">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                This tool needs the {engine?.title ?? "Crucible"} engine.{" "}
                <Link to="/engines" className="font-semibold underline-offset-2 hover:underline">Install it from Engines</Link>
              </span>
            </div>
          )}
          <Button variant="primary" size="md" className="w-full" leading={<Layers className="size-4" />} disabled={!file || missing} loading={busy} onClick={run}>
            Separate
          </Button>
        </>
      }
      result={
        busy ? (
          <Working title="Separating the voice…" hint="Long files take a minute or two. You can leave this page; both tracks are kept in History." />
        ) : out ? (
          <div className="tool-active-in space-y-5">
            <ResultHeader icon={<Layers />} tone="ok" title="Two clean tracks" detail="Both are saved in History too." />
            <Track icon={<Mic2 className="size-4" />} title="Voice" detail="Just the speech" src={out.vUrl} onSave={() => void saveBlob(out.voice, `${out.name} - voice.mp3`)} />
            <Track icon={<m.icon className="size-4" />} title={m.rest} detail="Everything except the voice" src={out.rUrl} onSave={() => void saveRest()} />
          </div>
        ) : (
          <ResultEmpty icon={<AudioWaveform />} title="Your separated tracks appear here">
            Add a file, pick what to remove, and you get the voice on its own plus everything else as a second track.
          </ResultEmpty>
        )
      }
    />
  );
}

function Track({ icon, title, detail, src, onSave }: { icon: React.ReactNode; title: string; detail: string; src: string; onSave: () => void }) {
  return (
    <div className="space-y-2 rounded-xl border border-line p-3">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-surface-3 text-ink-2">{icon}</span>
        <span>
          <span className="block text-[13.5px] font-semibold text-ink">{title}</span>
          <span className="block text-[11.5px] text-muted">{detail}</span>
        </span>
      </div>
      <AudioPlayer src={src} label={title} onDownload={onSave} />
    </div>
  );
}
