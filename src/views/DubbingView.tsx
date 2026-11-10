import { useEffect, useMemo } from "react";
import { Download, FileAudio, Globe, Languages, Mic2, Music, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, downloadFile } from "@/lib/api/client";
import { statusLabel } from "@/components/jobs/jobUtils";
import { errMessage, useJob, useVoices } from "@/lib/api/hooks";
import type { DubLine } from "@/lib/api/types";
import { PageHeader } from "@/components/shell/PageHeader";
import { Badge, Button, Card, Label, NativeSelect, ProgressBar, Switch } from "@/components/ui";
import { TrySample } from "@/components/tools/TrySample";
import { useSessionState } from "@/stores/session";

const NAMES: Record<string, string> = {
  en: "English", de: "German", es: "Spanish", fr: "French", it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish", ru: "Russian",
  uk: "Ukrainian", tr: "Turkish", ar: "Arabic", fa: "Persian", hi: "Hindi", ur: "Urdu", bn: "Bengali", pa: "Punjabi", ta: "Tamil",
  ja: "Japanese", ko: "Korean", zh: "Chinese", id: "Indonesian", ms: "Malay", vi: "Vietnamese", th: "Thai", sv: "Swedish",
  no: "Norwegian", da: "Danish", fi: "Finnish", el: "Greek", he: "Hebrew", cs: "Czech", ro: "Romanian", hu: "Hungarian",
};
const label = (c: string) => (NAMES[c] ? `${NAMES[c]} (${c})` : c);

/** A recording or video in another language, on the original timeline (speech to text, local translation, voices). */
export function DubbingView() {
  const qc = useQueryClient();
  const voices = useVoices();
  const langs = useQuery({ queryKey: ["dub-languages"], queryFn: api.dubLanguages, staleTime: Infinity });
  const [file, setFile] = useSessionState<File | null>("dub.file", null);
  const [to, setTo] = useSessionState("dub.to", () => localStorage.getItem("firevoice.dubTo") ?? "es");
  const [from, setFrom] = useSessionState("dub.from", "auto");
  const [voice, setVoice] = useSessionState("dub.voice", "");
  const [keep, setKeep] = useSessionState("dub.keep", false);
  const [consent, setConsent] = useSessionState("dub.consent", false);
  const [background, setBackground] = useSessionState("dub.background", 0);
  const [better, setBetter] = useSessionState("dub.better", false);
  const [music, setMusic] = useSessionState("dub.music", false);
  const [jobId, setJobId] = useSessionState<string | null>("dub.jobId", null);
  const [busy, setBusy] = useSessionState("dub.busy", false);
  const job = useJob(jobId).data;
  const [lines, setLines] = useSessionState<DubLine[]>("dub.lines", []);

  useEffect(() => localStorage.setItem("firevoice.dubTo", to), [to]);
  const sorted = useMemo(
    () => [...(langs.data?.languages ?? [])].sort((a, b) => (NAMES[a] ? 0 : 1) - (NAMES[b] ? 0 : 1) || label(a).localeCompare(label(b))),
    [langs.data],
  );
  const live = job && (job.status === "queued" || job.status === "running");
  const result = job?.status === "done" ? (job.result as { audio: string; files: string[]; lines: number; duration: number; source_language: string; target_language: string; voices_kept: boolean } | null) : null;
  const video = result?.files.find((n) => /\.(mp4|mov|mkv)$/.test(n));

  useEffect(() => {
    if (job?.status === "done" && jobId) {
      api
        .jobFile<{ lines?: DubLine[] }>(jobId, "lines.json")
        .then((d) => setLines(d?.lines ?? []))
        .catch(() => setLines([]));
    }
  }, [job?.status, jobId]);

  const start = async () => {
    if (!file) return;
    if (keep && !consent) return toast.error("Confirm you have the rights to clone the voices in this recording");
    setBusy(true);
    setLines([]);
    try {
      const j = await api.dub(file, { target_language: to, source_language: from, voice: keep ? "" : voice, keep_voices: keep, consent: keep && consent, background, translator: better ? "better" : "fast", keep_music: music });
      qc.setQueryData(["job", j.id], j);
      setJobId(j.id);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1100px] fade-up">
      <PageHeader title="Dubbing" subtitle="A recording or video in another language, on the original timeline. Speech to text, translation and voices all run on this machine." />
      {langs.isError && (
        <p className="mb-4 rounded-xl bg-warn-soft px-4 py-3 text-[13px] text-warn">
          Dubbing is not available yet. Restart FireVoice (or update it), then open this page again.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="mb-3 text-[14px] font-semibold text-ink flex items-center gap-2"><FileAudio className="size-4 shrink-0 text-fire" />Original</h3>
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface-2 px-4 py-8 text-center hover:border-fire">
            <Upload className="size-6 text-fire" />
            <span className="text-[13.5px] font-medium text-ink">{file ? file.name : "Choose a recording or video"}</span>
            <span className="text-[12px] text-faint">{file ? `${(file.size / 1e6).toFixed(1)} MB` : "audio or video, any format"}</span>
            <input type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <div className="mt-2 flex flex-wrap gap-1">
            <TrySample name="speech.mp3" onFile={setFile} />
            <TrySample name="conversation.mp3" onFile={setFile} label="Try a conversation" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="db-from" icon={<Globe />}>From</Label>
              <NativeSelect id="db-from" value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="auto">Detect</option>
                {sorted.map((c) => (
                  <option key={c} value={c}>{label(c)}</option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="db-to" icon={<Languages />}>Into</Label>
              <NativeSelect id="db-to" value={to} onChange={(e) => setTo(e.target.value)}>
                {sorted.map((c) => (
                  <option key={c} value={c}>{label(c)}</option>
                ))}
              </NativeSelect>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="mb-3 text-[14px] font-semibold text-ink flex items-center gap-2"><Mic2 className="size-4 shrink-0 text-fire" />Voices</h3>
          <div className="space-y-4">
            <div>
              <Label htmlFor="db-voice" icon={<Mic2 />}>Voice</Label>
              <NativeSelect id="db-voice" value={voice} onChange={(e) => setVoice(e.target.value)} disabled={keep}>
                <option value="">Default voice</option>
                {(voices.data ?? []).map((v) => (
                  <option key={v.voice_id} value={v.voice_id}>{v.name || v.voice_id}</option>
                ))}
              </NativeSelect>
            </div>
            <Switch checked={keep} onChange={setKeep} label="Keep the original voices" description="Clones each speaker for the dub; the clones are deleted afterwards" />
            {keep && <Switch checked={consent} onChange={setConsent} label="I have the rights to clone the voices in this recording" />}
            <div>
              <Label htmlFor="db-bg" hint={`${Math.round(background * 100)}%`} icon={<Music />}>Original audio underneath</Label>
              <input id="db-bg" type="range" min={0} max={0.5} step={0.05} value={background} onChange={(e) => setBackground(Number(e.target.value))} className="w-full accent-[var(--fire)]" />
            </div>
            <Switch checked={music} onChange={setMusic} label="Keep the music and effects" description="Separates them from the original voices (needs the voice separator from Engines)" />
            <Switch checked={better} onChange={setBetter} label="Better translation" description="A larger model (5 GB, downloaded once), clearly more accurate" />
            <Button leading={<Languages className="size-4" />} disabled={!file || !!live || !langs.data} loading={busy} onClick={start}>
              Dub it
            </Button>
          </div>
        </Card>
      </div>

      {job && (
        <Card className="mt-4 p-5">
          <div className="flex items-center gap-2">
            <Badge tone={job.status === "done" ? "ok" : job.status === "failed" ? "bad" : "info"}>{statusLabel(job.status)}</Badge>
            <span className="truncate text-[13px] text-muted">{job.message}</span>
            <div className="flex-1" />
            {live && (
              <Button size="sm" variant="ghost" leading={<X className="size-4" />} onClick={() => api.cancelJob(job.id).catch((e) => toast.error(errMessage(e)))}>
                Cancel
              </Button>
            )}
          </div>
          {live && <ProgressBar value={job.progress ?? 0} className="mt-3" />}
          {job.status === "failed" && <p className="mt-2 text-[13px] text-bad">{typeof job.error === "string" ? job.error : job.error?.message}</p>}
          {result && jobId && (
            <div className="mt-4 space-y-3">
              {video ? (
                <video controls src={api.jobFileUrl(jobId, video)} className="max-h-[420px] w-full rounded-xl bg-black" />
              ) : (
                <audio controls autoPlay src={api.jobFileUrl(jobId, result.audio)} className="w-full" />
              )}
              <div className="flex flex-wrap items-center gap-2">
                {result.files.filter((n) => n !== "lines.json").map((n) => (
                  <Button key={n} size="sm" variant="ghost" leading={<Download className="size-4" />} onClick={() => void downloadFile(api.jobFileUrl(jobId, n), n).catch((e) => toast.error(`Download failed: ${errMessage(e)}`))}>
                    {n}
                  </Button>
                ))}
                <span className="text-[12.5px] text-muted">
                  {NAMES[result.source_language] ?? result.source_language} → {NAMES[result.target_language] ?? result.target_language} · {result.lines} lines · {result.duration}s{result.voices_kept ? " · original voices kept" : ""}
                </span>
              </div>
              {lines.length > 0 && (
                <div className="max-h-[320px] overflow-auto rounded-lg border border-line">
                  <table className="w-full text-[13px]">
                    <tbody>
                      {lines.map((l, i) => (
                        <tr key={i} className="border-b border-line last:border-0 align-top">
                          <td className="px-3 py-2 text-faint tabular">{l.at.toFixed(1)}s</td>
                          <td className="px-3 py-2 text-muted">{l.text}</td>
                          <td className="px-3 py-2 text-ink">{l.translation}</td>
                          <td className="px-3 py-2 text-faint">{l.speed > 1 ? `${l.speed}x` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
