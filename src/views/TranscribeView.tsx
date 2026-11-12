import { Ear, Languages, Mic, Square, Tags } from "@/components/icons";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { errMessage } from "@/lib/api/hooks";
import type { STTResult } from "@/lib/api/types";
import { LANGUAGE_NAMES, uid } from "@/lib/utils";
import { PageHeader } from "@/components/shell/PageHeader";
import { RecentHistory } from "@/components/history/HistoryList";
import { Button, Card, CardBody, CardHeader, EmptyState, Input, Label, LabeledSlider, Select, Switch } from "@/components/ui";
import { AudioSource, type SourceFile } from "@/components/transcribe/AudioSource";
import { TranscriptResult } from "@/components/transcribe/TranscriptResult";
import { TrySample } from "@/components/tools/TrySample";
import { useSessionState } from "@/stores/session";

const LANG_OPTIONS = [
  { value: "auto", label: "Auto detect" },
  ...Object.entries(LANGUAGE_NAMES)
    .filter(([code]) => code !== "*")
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([value, label]) => ({ value, label })),
];


// shared across visits: Stop still works after leaving the page and coming back
const abortRef: { current: AbortController | null } = { current: null };
export function TranscribeView() {
  const [source, setSource] = useSessionState<SourceFile | null>("transcribe.source", null);
  const [language, setLanguage] = useSessionState("transcribe.language", "auto");
  const [beam, setBeam] = useSessionState("transcribe.beam", 5);
  const [keyterms, setKeyterms] = useSessionState("transcribe.keyterms", "");
  const [diarize, setDiarize] = useSessionState("transcribe.diarize", false);
  const [busy, setBusy] = useSessionState("transcribe.busy", false);
  const [error, setError] = useSessionState<string | null>("transcribe.error", null);
  const [result, setResult] = useSessionState<{ data: STTResult; source: SourceFile; trackId: string } | null>("transcribe.result", null);
  const qc = useQueryClient();

  const run = async () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const data = await api.stt(source.blob, { language, beam_size: beam, filename: source.name, keyterms: keyterms.trim() || undefined, diarize }, ctl.signal);
      setResult({ data, source, trackId: `stt-${uid()}` });
      toast.success(`Transcribed ${data.words.length} words · saved in History`);
      void qc.invalidateQueries({ queryKey: ["history"] });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = errMessage(e);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="page-width">
      <PageHeader title="Transcribe" subtitle="Speech to text with word timings, made on your GPU. Every transcript is saved in History." />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[440px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Audio" description="A file from disk or a fresh recording." />
            <CardBody>
              <AudioSource value={source} onChange={(f) => { setSource(f); setError(null); }} disabled={busy} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <TrySample name="conversation.mp3" label="Try a sample conversation" disabled={busy}
                  onFile={(f) => { setSource({ blob: f, name: f.name, duration: null }); setError(null); }} />
                <span className="text-[12px] text-faint">three speakers: turn on Label who speaks</span>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Options" />
            <CardBody className="space-y-4">
              <div>
                <Label htmlFor="stt-lang" icon={<Languages />}>Language</Label>
                <Select value={language} onChange={setLanguage} options={LANG_OPTIONS} ariaLabel="Language" disabled={busy} />
              </div>
              <LabeledSlider label="Accuracy" value={beam} onChange={setBeam} min={1} max={10} step={1} hint="Higher is more careful and slower" disabled={busy} onReset={() => setBeam(5)} />
              <div>
                <Label htmlFor="stt-keys" hint="comma-separated" icon={<Tags />}>Key terms</Label>
                <Input id="stt-keys" value={keyterms} onChange={(e) => setKeyterms(e.target.value)} placeholder="FireVoice, Siobhan, Inferno" disabled={busy} />
              </div>
              <Switch checked={diarize} onChange={setDiarize} label="Label who speaks" description="Speaker 1, Speaker 2… for interviews and podcasts" disabled={busy} />
              <div className="flex items-center gap-2 pt-1">
                {busy ? (
                  <Button variant="danger" size="lg" className="flex-1" leading={<Square className="size-4 fill-current" />} onClick={() => abortRef.current?.abort()}>
                    Cancel
                  </Button>
                ) : (
                  <Button variant="primary" size="lg" className="flex-1" disabled={!source} leading={<Ear className="size-4" />} onClick={() => void run()}>
                    Transcribe
                  </Button>
                )}
              </div>
              {busy && (
                <p className="flex items-center gap-2 text-[12.5px] text-muted" aria-live="polite">
                  <span className="size-2 animate-pulse rounded-full bg-fire" /> Listening… the first run also loads the speech model.
                </p>
              )}
              {error && (
                <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
                  {error}
                </p>
              )}
            </CardBody>
          </Card>
        </div>

        <div>
          {result ? (
            <TranscriptResult key={result.trackId} result={result.data} source={result.source} trackId={result.trackId} />
          ) : (
            <Card className="h-full">
              <EmptyState
                icon={<Mic />}
                title="Nothing transcribed yet"
                description="Drop a file or record a clip, then press Transcribe. You get the text, the detected language and a timestamp for every word, ready to copy as subtitles or send to Speak."
                className="h-full"
              />
            </Card>
          )}
        </div>
      </div>
      <RecentHistory kinds={["transcript"]} title="Recent transcripts" limit={6} empty="Transcripts are saved automatically and listed here." />
    </div>
  );
}
