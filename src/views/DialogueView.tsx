import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, MessagesSquare, Play, Search } from "lucide-react";
import { api } from "@/lib/api/client";
import { errMessage, useStyles, useVoices } from "@/lib/api/hooks";
import type { DialogueResult } from "@/lib/api/types";
import { saveBlob } from "@/lib/audio";
import { useStudio } from "@/stores/studio";
import { PageHeader } from "@/components/shell/PageHeader";
import { ArtTile, Badge, Button, Card, EmptyState, Label, NativeSelect, Slider, Textarea } from "@/components/ui";
import { cn, fmtTime } from "@/lib/utils";
import { RecentHistory } from "@/components/history/HistoryList";

const EXAMPLE = `Ayesha: Assalam o Alaikum, and welcome back to the show!
Bilal: Thanks for having me. (laughs) I promise to keep it short this time.
Ayesha: You said that last week too.
Bilal: Fair. But this time I mean it.
Narrator: He did not keep it short.`;

type Cast = Record<string, { voice?: string; style?: string }>;

/** Multi-speaker scripts: one line per turn as "Name: text"; every speaker keeps their own voice. */
export function DialogueView() {
  const voices = useVoices();
  const styles = useStyles();
  const studioEngine = useStudio((s) => s.engine);
  const qc = useQueryClient();
  const [script, setScript] = useState(() => localStorage.getItem("firevoice.dialogue") || EXAMPLE);   // a ready example on first visit
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [cast, setCast] = useState<Cast>({});
  const [turnsCount, setTurnsCount] = useState(0);
  const [gap, setGap] = useState(350);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<(DialogueResult & { url: string; blob: Blob }) | null>(null);
  const [now, setNow] = useState(0);
  const player = useRef<HTMLAudioElement>(null);
  const preview = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem("firevoice.dialogue", script), 400);
    return () => clearTimeout(t);
  }, [script]);

  const detect = async (text = script) => {
    if (!text.trim()) {
      toast.error("Write a script first");
      return;
    }
    try {
      const r = await api.dialogueParse(text, cast);
      setSpeakers(r.speakers);
      setCast(r.cast);
      setTurnsCount(r.turns.length);
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  // the cast is ready as soon as the page opens with a script (the example on a first visit)
  const detected = useRef(false);
  useEffect(() => {
    if (!detected.current && script.trim()) {
      detected.current = true;
      void detect(script);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const body = () => ({ script, cast, gap_ms: gap, defaults: { engine: studioEngine ?? undefined } });
  // the mix's object URL is released when a new mix replaces it or the page goes away
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);

  const render = async () => {
    setBusy("render");
    try {
      const r = await api.dialogue({ ...body(), format: "mp3", response: "json" });
      const blob = new Blob([Uint8Array.from(atob(r.audio_base64), (c) => c.charCodeAt(0))], { type: "audio/mpeg" });
      setResult({ ...r, blob, url: URL.createObjectURL(blob) });
      void qc.invalidateQueries({ queryKey: ["history"] });
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const downloadZip = async () => {
    setBusy("zip");
    try {
      await saveBlob(await api.dialogueZip({ ...body(), format: "wav" }), "dialogue.zip");
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const voiceOf = (id?: string) => (voices.data ?? []).find((v) => v.voice_id === id);

  return (
    <div className="mx-auto max-w-[1300px]">
      <PageHeader title="Dialogue" subtitle="One line per turn as “Name: what they say”. Every speaker keeps their own voice; you get one mix, a track per speaker and labelled subtitles." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-[14px] font-semibold text-ink">Script</h3>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => { setScript(EXAMPLE); void detect(EXAMPLE); }}>Example</Button>
          </div>
          <Textarea rows={14} value={script} onChange={(e) => setScript(e.target.value)} aria-label="Dialogue script"
            placeholder={"Ayesha: Assalam o Alaikum! Welcome to the show.\nBilal: Thanks for having me. (laughs)\nNarrator: And so it began."} />
          <p className="mt-2 text-[12px] text-faint">
            Sound cues on their own line: <code className="font-mono">[sfx: a door creaks open, 2s]</code> and one{" "}
            <code className="font-mono">[music: calm lo-fi piano]</code> bed under everything (needs the sound engines from Engines).
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="outline" leading={<Search className="size-4" />} onClick={() => void detect()}>Find speakers</Button>
            {turnsCount > 0 && <span className="text-[12.5px] text-muted">{turnsCount} turns · {speakers.length} speaker{speakers.length === 1 ? "" : "s"}</span>}
          </div>
        </Card>
        <Card className="p-4">
          <h3 className="mb-2 text-[14px] font-semibold text-ink">Cast</h3>
          {speakers.length === 0 ? (
            <EmptyState icon={<MessagesSquare className="size-5" />} title="No speakers yet" description="Write a script and press Find speakers." />
          ) : (
            <div className="space-y-2">
              {speakers.map((n) => {
                const c = cast[n] ?? {};
                const v = voiceOf(c.voice);
                return (
                  <div key={n} className="flex items-center gap-2">
                    <ArtTile seed={c.voice ?? n} image={api.voiceAvatarUrl(v)} className="size-9 shrink-0 text-[11px] font-bold">{v?.avatar ? null : n.slice(0, 2).toUpperCase()}</ArtTile>
                    <span className="w-24 shrink-0 truncate text-[13.5px] font-semibold text-ink">{n}</span>
                    <NativeSelect aria-label={`Voice for ${n}`} value={c.voice ?? ""} onChange={(e) => setCast({ ...cast, [n]: { ...c, voice: e.target.value } })}>
                      {(voices.data ?? []).map((x) => <option key={x.voice_id} value={x.voice_id}>{x.name || x.voice_id}</option>)}
                    </NativeSelect>
                    <NativeSelect aria-label={`Style for ${n}`} className="w-36 shrink-0" value={c.style ?? ""} onChange={(e) => setCast({ ...cast, [n]: { ...c, style: e.target.value || undefined } })}>
                      <option value="">default style</option>
                      {(styles.data ?? []).map((s) => <option key={s.name} value={s.name}>{s.title || s.name}</option>)}
                    </NativeSelect>
                    <Button size="icon-sm" variant="ghost" aria-label={`Hear ${n}'s voice`} onClick={() => {
                      if (!c.voice) return;
                      preview.current?.pause();
                      preview.current = new Audio(api.voicePreviewUrl(c.voice));
                      preview.current.play().catch(() => toast.error("Could not play this voice's preview"));
                    }}><Play className="size-4" /></Button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-4">
            <Label hint={`${gap} ms`}>Pause between speakers</Label>
            <Slider value={gap} min={0} max={1500} step={50} onChange={setGap} />
          </div>
          <Button className="mt-3" variant="primary" leading={<Play className="size-4" />} onClick={render} disabled={!speakers.length || !!busy} loading={busy === "render"}>
            Render dialogue
          </Button>
          {result && (
            <div className="mt-4 space-y-2">
              <audio ref={player} controls autoPlay src={result.url} className="w-full" onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
              <div className="max-h-80 space-y-0.5 overflow-y-auto">
                {result.turns.map((t, i) => {
                  const on = now >= t.start && (i === result.turns.length - 1 || now < result.turns[i + 1].start);
                  return (
                    <button key={i} type="button" onClick={() => { if (player.current) { player.current.currentTime = t.start; void player.current.play(); } }}
                      className={cn("block w-full rounded-lg px-2.5 py-1.5 text-left text-[13.5px] leading-relaxed text-ink-2 hover:bg-surface-2", on && "bg-fire-soft text-ink")}>
                      <Badge>{t.speaker}</Badge> {t.text} <span className="text-[11.5px] text-muted">{fmtTime(t.start)}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" leading={<Download className="size-4" />} onClick={() => void saveBlob(result.blob, "dialogue.mp3")}>Mix (MP3)</Button>
                <Button size="sm" variant="ghost" leading={<Download className="size-4" />} onClick={downloadZip} loading={busy === "zip"}>Mix, stems and subtitles (zip)</Button>
              </div>
            </div>
          )}
        </Card>
      </div>
      <RecentHistory kinds={["dialogue"]} title="Recent dialogues" limit={5} empty="Dialogues you render are saved automatically and listed here." />
    </div>
  );
}
