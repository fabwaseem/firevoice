import { Download, ExternalLink, Play, X } from "lucide-react";
import type { Job } from "@/lib/api/types";
import { api } from "@/lib/api/client";
import { fmtDuration, relTime, truncate } from "@/lib/utils";
import { usePlayer } from "@/stores/player";
import { Badge, Button, Card, CardBody, CardHeader, Equalizer, ProgressBar } from "@/components/ui";
import { errorText, hasAudio, jobTitle, payloadSummary, resultCount, resultNumber, statusTone } from "./jobUtils";
import { engineName } from "@/lib/engineNames";

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
  const player = usePlayer();
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
  const isCurrent = player.track?.id === job.id;

  return (
    <Card raised className="sticky top-0 fade-up">
      <CardHeader
        title={title}
        description={
          <span className="flex items-center gap-2">
            <Badge tone={statusTone(job.status)} dot={job.status !== "running"}>
              {job.status === "running" && <Equalizer className="h-2.5" />}
              {job.status}
            </Badge>
            <span className="capitalize">{job.kind}</span>
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
              leading={isCurrent && player.playing ? <Equalizer className="h-3" /> : <Play className="size-4 fill-current" />}
              onClick={() =>
                isCurrent
                  ? player.toggle()
                  : player.load({ id: job.id, title, subtitle: `${job.kind} · ${relTime(job.created)}`, src: api.jobAudioUrl(job.id), href: `/jobs/${job.id}`, duration })
              }
            >
              {isCurrent && player.playing ? "Pause" : "Play"}
            </Button>
            <Button size="sm" leading={<Download className="size-4" />} onClick={() => window.open(api.jobAudioUrl(job.id, true), "_blank")}>
              Download
            </Button>
          </div>
        )}

        <Section title="Request">
          <KV
            rows={[
              ["Engine", p.engine ? engineName(String(p.engine)) : p.engine],
              ["Voice", p.voice],
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
                ["Speed", rtf != null ? `${rtf.toFixed(2)} RTF` : undefined],
                ["Chunks", chunks],
                ["Takes", takes != null ? `${takes}${retries ? ` (${retries} re-rolled)` : ""}` : undefined],
                ["Words timed", words],
                ["Voice created", resultVoice],
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

        {job.status === "done" && (
          <Section title="Files">
            <div className="flex flex-wrap gap-2">
              {(job.kind === "tts" ? ["words.json"] : ["manifest.json"]).map((name) => (
                <a
                  key={name}
                  href={api.jobFileUrl(job.id, name)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-line bg-surface px-3 font-mono text-[12px] text-ink-2 hover:border-line-strong hover:text-ink"
                >
                  {name}
                  <ExternalLink className="size-3.5" />
                </a>
              ))}
            </div>
          </Section>
        )}

        <Section title="Timing">
          <KV
            rows={[
              ["Created", new Date(job.created * 1000).toLocaleString()],
              ["Started", job.started ? new Date(job.started * 1000).toLocaleString() : undefined],
              ["Finished", job.finished ? new Date(job.finished * 1000).toLocaleString() : undefined],
              ["Job id", <span className="font-mono text-[12px]">{job.id}</span>],
            ]}
          />
        </Section>
      </CardBody>
    </Card>
  );
}
