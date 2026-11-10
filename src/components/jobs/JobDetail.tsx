import { Download, FileDown, Play, X } from "lucide-react";
import { toast } from "sonner";
import type { Job } from "@/lib/api/types";
import { api, downloadFile, safeFileName } from "@/lib/api/client";
import { errMessage, useVoices } from "@/lib/api/hooks";
import { fmtDuration, relTime, truncate } from "@/lib/utils";
import { usePlayer } from "@/stores/player";
import { Badge, Button, Card, CardBody, CardHeader, Equalizer, ProgressBar } from "@/components/ui";
import { downloadJobAudio, errorText, hasAudio, jobAudioSrc, jobTitle, kindLabel, payloadSummary, resultCount, resultNumber, statusLabel, statusTone } from "./jobUtils";
import { engineName } from "@/lib/engineNames";
import { WordDownloads } from "@/components/tools/WordDownloads";
import type { TimedWord } from "@/lib/words";

const FILE_LABEL: Record<string, string> = {
  "words.json": "Word timings",
  "manifest.json": "Job details",
  "lines.json": "Translated lines",
};

/** The extra files a finished job wrote, by kind. */
function jobFiles(job: Job): string[] {
  if (job.kind === "dub") {
    const files = job.result?.files;
    return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
  }
  if (job.kind === "install") return [];
  return job.kind === "tts" ? ["words.json"] : ["manifest.json"];
}

function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!shown.length) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 truncate text-ink tabular">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function JobDetail({ job, onClose }: { job: Job; onClose: () => void }) {
  const isCurrent = usePlayer((s) => s.track?.id === job.id);
  const isPlaying = usePlayer((s) => s.playing && s.track?.id === job.id);
  const voices = useVoices();
  const voiceName = (id?: string) => (id ? (voices.data ?? []).find((v) => v.voice_id === id)?.name || id : undefined);
  const title = jobTitle(job);
  const err = errorText(job);
  const p = payloadSummary(job);
  const duration = resultNumber(job, "duration");
  const rtf = resultNumber(job, "rtf");
  const takes = resultNumber(job, "takes");
  const retries = resultNumber(job, "retries");
  const chunks = resultNumber(job, "chunks");
  const words = resultCount(job, "words");
  const seconds = resultNumber(job, "seconds");
  const warnings = Array.isArray(job.result?.warnings) ? (job.result!.warnings as string[]) : [];
  const resultVoice = typeof job.result?.voice_id === "string" ? (job.result!.voice_id as string) : undefined;
  const resultVoiceName = typeof job.result?.name === "string" && job.result.name ? (job.result.name as string) : voiceName(resultVoice);
  const files = job.status === "done" ? jobFiles(job) : [];

  const play = () => {
    const player = usePlayer.getState();
    if (isCurrent) player.toggle();
    else player.load({ id: job.id, title, subtitle: `${kindLabel(job.kind)} · ${relTime(job.created)}`, src: jobAudioSrc(job), href: `/jobs/${job.id}`, duration });
  };
  const download = async () => {
    try {
      await downloadJobAudio(job);
    } catch (e) {
      toast.error(`Download failed: ${errMessage(e)}`);
    }
  };
  const downloadExtra = async (name: string) => {
    try {
      const base = safeFileName(title, job.id);
      await downloadFile(api.jobFileUrl(job.id, name), name.startsWith(base) ? name : `${base} - ${name}`);
    } catch (e) {
      toast.error(`Download failed: ${errMessage(e)}`);
    }
  };

  return (
    <Card raised className="sticky top-0 fade-up">
      <CardHeader
        title={title}
        description={
          <span className="flex items-center gap-2">
            <Badge tone={statusTone(job.status)} dot={job.status !== "running"}>
              {job.status === "running" && <Equalizer className="h-2.5" />}
              {statusLabel(job.status)}
            </Badge>
            <span>{kindLabel(job.kind)}</span>
            <span aria-hidden>·</span>
            <span>{relTime(job.created)}</span>
          </span>
        }
        action={
          <Button variant="ghost" size="icon-sm" aria-label="Close details" onClick={onClose}>
            <X className="size-4" />
          </Button>
        }
      />
      <CardBody className="space-y-4">
        {job.status === "running" && (
          <div>
            <ProgressBar value={job.progress ?? 0} />
            <p className="mt-1.5 text-[12.5px] text-muted">
              {job.step != null && job.steps != null && <span className="tabular">Step {job.step} of {job.steps} · </span>}
              {job.message ?? "Working…"}
            </p>
          </div>
        )}
        {err && (
          <div role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">
            {err}
          </div>
        )}

        {hasAudio(job) && (
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              leading={isPlaying ? <Equalizer className="h-3" /> : <Play className="size-4 fill-current" />}
              onClick={play}
            >
              {isPlaying ? "Pause" : "Play"}
            </Button>
            <Button size="sm" leading={<Download className="size-4" />} onClick={download}>
              Download
            </Button>
          </div>
        )}

        <Section title="Request">
          <KV
            rows={[
              ["Engine", p.engine ? engineName(String(p.engine)) : p.engine],
              ["Voice", voiceName(p.voice)],
              ["Style", p.style],
              ["Lines", p.lines],
              ["Description", p.description],
            ]}
          />
          {p.text && <p className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-ink-2">{truncate(p.text, 320)}</p>}
        </Section>

        {job.result && (
          <Section title="Result">
            <KV
              rows={[
                ["Audio", duration != null ? fmtDuration(duration) : undefined],
                ["Render time", seconds != null ? fmtDuration(seconds) : undefined],
                ["Speed", rtf != null && rtf > 0 ? (rtf <= 1 ? `${(1 / rtf).toFixed(1)}× faster than real time` : `${rtf.toFixed(1)}× slower than real time`) : undefined],
                ["Sentences", chunks],
                ["Takes", takes != null ? `${takes}${retries ? ` (${retries} re-rolled)` : ""}` : undefined],
                ["Words timed", words],
                ["Voice created", resultVoiceName],
                ["Elapsed", job.elapsed != null ? fmtDuration(job.elapsed) : undefined],
              ]}
            />
            {warnings.length > 0 && (
              <ul className="mt-2 space-y-1 text-[12.5px] text-warn">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {files.length > 0 && (
          <Section title="Files">
            <div className="flex flex-wrap gap-2">
              {files.map((name) =>
                name === "words.json" ? (
                  // every word with its time: spreadsheet, JSON or word-by-word subtitles
                  <WordDownloads key={name} variant="ghost" baseName={job.title || "speech"} words={() => api.jobFile<TimedWord[]>(job.id, name)} />
                ) : (
                  <Button key={name} size="sm" variant="ghost" leading={<FileDown className="size-4" />} onClick={() => void downloadExtra(name)}>
                    {FILE_LABEL[name] ?? name}
                  </Button>
                ),
              )}
            </div>
          </Section>
        )}

        <Section title="Timing">
          <KV
            rows={[
              ["Created", new Date(job.created * 1000).toLocaleString()],
              ["Started", job.started ? new Date(job.started * 1000).toLocaleString() : undefined],
              ["Finished", job.finished ? new Date(job.finished * 1000).toLocaleString() : undefined],
              ["Reference", <span className="font-mono text-[12px]">{job.id.slice(0, 8)}</span>],
            ]}
          />
        </Section>
      </CardBody>
    </Card>
  );
}
