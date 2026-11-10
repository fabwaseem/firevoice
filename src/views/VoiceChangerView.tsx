import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Mic, Mic2, Square, Upload, Wand2 } from "lucide-react";
import { api } from "@/lib/api/client";
import { errMessage, useVoices } from "@/lib/api/hooks";
import type { ClipCheck } from "@/lib/api/types";
import { saveBlob } from "@/lib/audio";
import { useStudio } from "@/stores/studio";
import { PageHeader } from "@/components/shell/PageHeader";
import { WatermarkCheck } from "@/components/tools/WatermarkCheck";
import { QualityCheck } from "@/components/tools/QualityReport";
import { SeparateCard } from "@/components/tools/SeparateCard";
import { Badge, Button, Card, Label, NativeSelect } from "@/components/ui";
import { TrySample } from "@/components/tools/TrySample";
import { RecentHistory } from "@/components/history/HistoryList";
import { useReleaseOnReplace, useSessionState } from "@/stores/session";

/** Voice changer: keep the words, timing and delivery of a recording, swap the voice. */
export function VoiceChangerView() {
  const voices = useVoices();
  const studioVoice = useStudio((s) => s.voice);
  const [source, setSource] = useSessionState<{ blob: Blob; name: string; url: string } | null>("changer.source", null);
  const [check, setCheck] = useSessionState<ClipCheck | null>("changer.check", null);
  const [voice, setVoice] = useSessionState("changer.voice", studioVoice);
  const [result, setResult] = useSessionState<{ blob: Blob; url: string; duration: number } | null>("changer.result", null);
  const [busy, setBusy] = useSessionState("changer.busy", false);
  const [recording, setRecording] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const latest = useRef(0);

  // leaving the page stops a recording but not a conversion: it finishes and is kept in History
  useEffect(() => () => recRef.current?.stop(), []);
  // release a preview's object URL when it is replaced (not when the page closes: the preview is still here on return)
  useReleaseOnReplace(source?.url);
  useReleaseOnReplace(result?.url);

  const use = (blob: Blob, name: string) => {
    const n = ++latest.current;
    setSource({ blob, name, url: URL.createObjectURL(blob) });
    setResult(null);
    setCheck(null);
    // only the newest file's check is shown, even when an older one answers later
    api.analyzeAudio(blob, name).then((c) => n === latest.current && setCheck(c)).catch(() => n === latest.current && setCheck(null));
  };

  const record = async () => {
    if (recRef.current) {
      recRef.current.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recRef.current = null;
        setRecording(false);
        use(new Blob(chunks, { type: rec.mimeType }), "recording.webm");
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      toast.error(`Microphone: ${errMessage(e)}`);
    }
  };

  const convert = async () => {
    if (!source) return;
    setBusy(true);
    try {
      const r = await api.voiceChange(source.blob, source.name, voice);
      setResult({ blob: r.blob, url: URL.createObjectURL(r.blob), duration: r.duration });
      void qc.invalidateQueries({ queryKey: ["history"] });
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const vname = (voices.data ?? []).find((v) => v.voice_id === voice)?.name ?? "voice";

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title="Voice changer" subtitle="Record or upload a performance: your words, timing and delivery stay, the voice becomes any library voice." />
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 text-[14px] font-semibold text-ink flex items-center gap-2"><Mic className="size-4 shrink-0 text-fire" />Your recording</h3>
          <input ref={fileRef} type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) use(f, f.name); e.target.value = ""; }} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" leading={<Upload className="size-4" />} onClick={() => fileRef.current?.click()}>Choose a file</Button>
            <Button variant={recording ? "danger" : "outline"} leading={recording ? <Square className="size-4" /> : <Mic className="size-4" />} onClick={record}>
              {recording ? "Stop" : "Record"}
            </Button>
          </div>
          {!source && (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-faint">
              Nothing to hand? <TrySample name="speech.mp3" onFile={(f) => use(f, f.name)} />
            </p>
          )}
          {source && (
            <div className="mt-4 space-y-2">
              <audio controls src={source.url} className="w-full" />
              <p className="text-[12.5px] text-muted">{source.name}</p>
              {check && (
                <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                  <Badge tone={check.verdict === "good" ? "ok" : check.verdict === "poor" ? "bad" : "warn"}>
                    {check.verdict === "good" ? "Clean recording" : check.verdict === "poor" ? "Noisy recording" : "Usable recording"}
                  </Badge>
                  <span className="text-muted">{check.duration}s</span>
                  {check.notes.map((n) => <span key={n} className="text-muted">· {n}</span>)}
                </div>
              )}
            </div>
          )}
        </Card>
        <Card className="p-4">
          <h3 className="mb-3 text-[14px] font-semibold text-ink flex items-center gap-2"><Wand2 className="size-4 shrink-0 text-fire" />New voice</h3>
          <Label icon={<Mic2 />}>Voice</Label>
          <NativeSelect value={voice} onChange={(e) => setVoice(e.target.value)}>
            <option value="default">Default voice</option>
            {(voices.data ?? []).map((v) => <option key={v.voice_id} value={v.voice_id}>{v.name || v.voice_id}{v.tagline ? ` · ${v.tagline}` : ""}</option>)}
          </NativeSelect>
          <Button className="mt-3" variant="primary" leading={<Wand2 className="size-4" />} onClick={convert} disabled={!source || busy} loading={busy}>Change voice</Button>
          {result && (
            <div className="mt-4 space-y-2">
              <audio controls autoPlay src={result.url} className="w-full" />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" leading={<Download className="size-4" />} onClick={() => void saveBlob(result.blob, `${vname}-voice-changer.mp3`)}>Download</Button>
                <span className="text-[12.5px] text-muted">{result.duration}s in {vname} · saved in History</span>
              </div>
            </div>
          )}
        </Card>
      </div>
      <RecentHistory kinds={["changer"]} title="Recent voice changes" limit={5} empty="Voice changes are saved automatically and listed here." />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <SeparateCard />
        <QualityCheck />
        <WatermarkCheck />
      </div>
    </div>
  );
}
