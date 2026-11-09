import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Check, Download, Layers, Lock, LockOpen, Package, Pause, Play, Plus, RotateCcw, Trash2, Zap } from "lucide-react";
import { api } from "@/lib/api/client";
import { errMessage, qk, useJob, useProject, useStyles, useVoices } from "@/lib/api/hooks";
import type { AudiobookCheck, ChapterEdit, Paragraph, ParagraphStatus, Project } from "@/lib/api/types";
import { saveBlob } from "@/lib/audio";
import { usePlayer } from "@/stores/player";
import { LoadError } from "@/components/shell/PageHeader";
import { Badge, Button, Card, Input, Label, NativeSelect, Skeleton, Switch, Textarea, Tooltip } from "@/components/ui";
import { TakesPanel } from "@/components/speak/TakesPanel";
import { cn, fmtTime } from "@/lib/utils";

const STATUS: Record<ParagraphStatus | "working", { label: string; tone: "neutral" | "ok" | "warn" | "fire" | "info" }> = {
  draft: { label: "Draft", tone: "neutral" },
  stale: { label: "Changed", tone: "warn" },
  rendered: { label: "Ready", tone: "ok" },
  locked: { label: "Locked", tone: "fire" },
  working: { label: "Rendering", tone: "info" },
};

/** One project: chapters of paragraphs, each rendered with its own takes. Edits save themselves. */
export function ProjectEditorView() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useProject(projectId);
  const voices = useVoices();
  const styles = useStyles();
  const [draft, setDraft] = useState<ChapterEdit[] | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState<"saved" | "saving" | "error">("saved");
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [openTakes, setOpenTakes] = useState<Set<string>>(new Set());
  const [jobId, setJobId] = useState<string | null>(null);
  const [fmt, setFmt] = useState("m4b");
  const [master, setMaster] = useState(false);
  const [check, setCheck] = useState<AudiobookCheck | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const job = useJob(jobId);

  const p = q.data;
  // the editable copy starts from the server and then follows the user's typing
  useEffect(() => {
    if (p && draft === null) {
      setDraft(p.chapters.map((c) => ({ id: c.id, title: c.title, paragraphs: c.paragraphs.map((x) => ({ id: x.id, text: x.text, voice: x.voice ?? null, style: x.style ?? null, pace: x.pace ?? null, locked: x.locked })) })));
      setTitle(p.title);
    }
  }, [p, draft]);
  useEffect(() => () => audio.current?.pause(), []);

  const statusOf = useMemo(() => {
    const m = new Map<string, Paragraph>();
    p?.chapters.forEach((c) => c.paragraphs.forEach((x) => m.set(x.id, x)));
    return m;
  }, [p]);

  const apply = useCallback((proj: Project, resetDraft = false) => {
    qc.setQueryData(qk.project(proj.id), proj);
    qc.invalidateQueries({ queryKey: qk.projects });
    if (resetDraft) {
      setDraft(proj.chapters.map((c) => ({ id: c.id, title: c.title, paragraphs: c.paragraphs.map((x) => ({ id: x.id, text: x.text, voice: x.voice ?? null, style: x.style ?? null, pace: x.pace ?? null, locked: x.locked })) })));
    }
  }, [qc]);

  const save = useCallback(async (chapters: ChapterEdit[] | null, extra: { title?: string; defaults?: Record<string, unknown> } = {}, resetDraft = false) => {
    if (!projectId) return null;
    setSaving("saving");
    try {
      const proj = await api.updateProject(projectId, { ...(chapters ? { chapters } : {}), ...extra });
      apply(proj, resetDraft);
      setSaving("saved");
      return proj;
    } catch (e) {
      setSaving("error");
      toast.error(errMessage(e));
      return null;
    }
  }, [projectId, apply]);

  // edits save themselves 800 ms after the last change
  const edit = (next: ChapterEdit[], nextTitle = title) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(next, { title: nextTitle }), 800);
  };
  const flush = async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      await save(draft, { title });
    }
  };

  // follow a "render changed" job: refresh statuses as paragraphs finish
  useEffect(() => {
    if (!jobId || !job.data) return;
    void qc.invalidateQueries({ queryKey: qk.project(projectId) });
    if (["done", "failed", "cancelled"].includes(job.data.status)) {
      const r = job.data.result as { rendered?: number; failed?: unknown[] } | null;
      if (job.data.status === "done") toast.success(`Rendered ${r?.rendered ?? 0} paragraph(s)${r?.failed?.length ? `, ${r.failed.length} failed` : ""}`);
      else toast.error(`Render ${job.data.status}`);
      setJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.data?.status, job.data?.progress]);

  if (q.isLoading || !draft) return <div className="mx-auto max-w-[1100px] space-y-3"><Skeleton className="h-12" /><Skeleton className="h-64" /></div>;
  if (q.isError || !p) return <LoadError message={errMessage(q.error)} retry={() => void q.refetch()} />;

  const todo = p.counts.draft + p.counts.stale;
  const voiceName = (id?: string | null) => (voices.data ?? []).find((v) => v.voice_id === id)?.name ?? (id && id !== "default" ? id : "Default voice");

  const play = (key: string, src: string) => {
    audio.current?.pause();
    if (playing === key) {
      setPlaying(null);
      return;
    }
    usePlayer.getState().setPlaying(false);
    const a = new Audio(src);
    a.onended = () => setPlaying(null);
    audio.current = a;
    setPlaying(key);
    a.play().catch((e) => { setPlaying(null); toast.error(errMessage(e)); });
  };

  const renderOne = async (paraId: string) => {
    await flush();
    setWorking((s) => new Set(s).add(paraId));
    try {
      apply(await api.renderParagraph(projectId, paraId));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setWorking((s) => { const n = new Set(s); n.delete(paraId); return n; });
    }
  };

  const renderChanged = async () => {
    await flush();
    try {
      const j = await api.renderProject(projectId, "stale");
      setJobId(j.id);
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  const doExport = async () => {
    setBusy("export");
    try {
      const { blob, name } = await api.exportProject(projectId, fmt, master ? "audiobook" : null);
      await saveBlob(blob, name);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doCheck = async () => {
    setBusy("check");
    try {
      setCheck(await api.checkProject(projectId, master ? "audiobook" : null));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doBundle = async () => {
    setBusy("bundle");
    try {
      const { blob, name } = await api.projectBundle(projectId);
      await saveBlob(blob, name);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${p.title}" and every take in it? This cannot be undone.`)) return;
    try {
      await api.deleteProject(projectId);
      qc.invalidateQueries({ queryKey: qk.projects });
      navigate("/projects");
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  const setDefaults = async (patch: Record<string, unknown>) => {
    const defaults = { ...p.defaults, ...patch };
    for (const k of Object.keys(defaults)) if (defaults[k] === "" || defaults[k] === undefined) delete defaults[k];
    await flush();
    await save(null, { defaults });
  };

  const structural = async (next: ChapterEdit[]) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setDraft(next);
    await save(next, { title }, true);
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link to="/projects" className="inline-flex h-8 items-center gap-1.5 rounded-[10px] px-2 text-[13px] text-ink-2 hover:bg-surface-3"><ArrowLeft className="size-4" />Projects</Link>
        <input aria-label="Project title" value={title} onChange={(e) => { setTitle(e.target.value); edit(draft, e.target.value); }}
          className="min-w-[200px] flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-[24px] font-bold tracking-tight text-ink hover:border-line focus:border-fire focus:outline-none" />
        <Badge tone="ok">{p.counts.rendered + p.counts.locked} ready</Badge>
        {p.counts.stale > 0 && <Badge tone="warn">{p.counts.stale} changed</Badge>}
        {p.counts.draft > 0 && <Badge>{p.counts.draft} draft</Badge>}
        <Badge>{p.words} words · {fmtTime(p.duration)}</Badge>
        <span className={cn("text-[12px]", saving === "error" ? "text-bad" : "text-muted")}>{saving === "saving" ? "saving…" : saving === "error" ? "not saved" : "saved"}</span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" leading={<Zap className="size-4" />} onClick={renderChanged} disabled={!todo || !!jobId} loading={!!jobId}>
          {jobId ? job.data?.message || "Rendering" : todo ? `Render ${todo} changed paragraph${todo === 1 ? "" : "s"}` : "Everything is rendered"}
        </Button>
        <div className="flex-1" />
        <NativeSelect aria-label="Export format" value={fmt} onChange={(e) => setFmt(e.target.value)} className="w-auto">
          <option value="m4b">M4B audiobook (chapters)</option><option value="mp3">MP3</option><option value="wav">WAV</option>
          <option value="srt">Subtitles (SRT)</option><option value="vtt">Subtitles (VTT)</option>
        </NativeSelect>
        <Tooltip content="Bring the export inside audiobook limits (loudness, peaks)"><span><Switch checked={master} onChange={setMaster} label="Audiobook master" /></span></Tooltip>
        <Button variant="outline" leading={<Download className="size-4" />} onClick={doExport} loading={busy === "export"}>Export</Button>
        <Button variant="outline" leading={<Check className="size-4" />} onClick={doCheck} loading={busy === "check"}>Check</Button>
        <Tooltip content="The project with every take, as one zip"><Button variant="ghost" leading={<Package className="size-4" />} onClick={doBundle} loading={busy === "bundle"}>Bundle</Button></Tooltip>
        <Tooltip content="Delete project"><Button variant="ghost" size="icon-sm" aria-label="Delete project" onClick={remove}><Trash2 className="size-4" /></Button></Tooltip>
      </div>

      <details className="mb-4 rounded-2xl border border-line bg-surface p-4">
        <summary className="cursor-pointer text-[14px] font-semibold text-ink">
          Defaults <span className="ml-2 text-[12.5px] font-normal text-muted">voice {voiceName(p.defaults.voice)} · style {p.defaults.style ?? "conversational"} · used by every paragraph without its own</span>
        </summary>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <div><Label>Voice</Label>
            <NativeSelect value={p.defaults.voice ?? "default"} onChange={(e) => void setDefaults({ voice: e.target.value })}>
              <option value="default">Default voice</option>
              {(voices.data ?? []).map((v) => <option key={v.voice_id} value={v.voice_id}>{v.name || v.voice_id}</option>)}
            </NativeSelect></div>
          <div><Label>Style</Label>
            <NativeSelect value={p.defaults.style ?? "conversational"} onChange={(e) => void setDefaults({ style: e.target.value })}>
              {(styles.data ?? []).map((s) => <option key={s.name} value={s.name}>{s.title || s.name}</option>)}
            </NativeSelect></div>
          <div><Label>Pause between paragraphs (ms)</Label>
            <Input type="number" min={0} max={30000} defaultValue={p.defaults.paragraph_gap_ms ?? 700} onBlur={(e) => void setDefaults({ paragraph_gap_ms: Number(e.target.value) })} /></div>
          <div><Label>Pause between chapters (ms)</Label>
            <Input type="number" min={0} max={30000} defaultValue={p.defaults.chapter_gap_ms ?? 2500} onBlur={(e) => void setDefaults({ chapter_gap_ms: Number(e.target.value) })} /></div>
        </div>
      </details>

      {check && <CheckCard check={check} />}

      <div className="space-y-4">
        {draft.map((ch, ci) => {
          const server = p.chapters.find((c) => c.id === ch.id);
          return (
            <Card key={ch.id ?? ci} className="overflow-hidden p-0">
              <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <span className="text-[12px] text-muted tabular">{ci + 1}</span>
                <input aria-label="Chapter title" value={ch.title}
                  onChange={(e) => edit(draft.map((c, i) => (i === ci ? { ...c, title: e.target.value } : c)))}
                  className="flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-[16px] font-semibold text-ink hover:border-line focus:border-fire focus:outline-none" />
                <span className="text-[12px] text-muted">{ch.paragraphs.length} paragraph{ch.paragraphs.length === 1 ? "" : "s"} · {fmtTime(server?.duration ?? 0)}</span>
                {ch.id && (
                  <Tooltip content="Play the chapter">
                    <Button size="icon-sm" variant="ghost" aria-label="Play chapter" onClick={() => play(`ch:${ch.id}`, api.chapterAudioUrl(projectId, ch.id!))}>
                      {playing === `ch:${ch.id}` ? <Pause className="size-4" /> : <Play className="size-4" />}
                    </Button>
                  </Tooltip>
                )}
                <Tooltip content="Delete chapter">
                  <Button size="icon-sm" variant="ghost" aria-label="Delete chapter" onClick={() => {
                    if (window.confirm(`Delete "${ch.title}" and its ${ch.paragraphs.length} paragraph(s), with their takes?`)) void structural(draft.filter((_, i) => i !== ci));
                  }}><Trash2 className="size-4" /></Button>
                </Tooltip>
              </div>
              <div className="divide-y divide-line">
                {ch.paragraphs.map((para, pi) => {
                  const srv = para.id ? statusOf.get(para.id) : undefined;
                  const st: ParagraphStatus | "working" = para.id && working.has(para.id) ? "working" : srv?.status ?? "draft";
                  const update = (patch: Partial<typeof para>) => edit(draft.map((c, i) => (i === ci ? { ...c, paragraphs: c.paragraphs.map((x, j) => (j === pi ? { ...x, ...patch } : x)) } : c)));
                  return (
                    <div key={para.id ?? pi} className="grid gap-3 px-4 py-3 md:grid-cols-[88px_1fr_auto]">
                      <div className="flex flex-col items-start gap-1">
                        <Badge tone={STATUS[st].tone}>{STATUS[st].label}</Badge>
                        {srv?.render && <span className="text-[11.5px] text-muted tabular">{fmtTime(srv.render.duration)}</span>}
                      </div>
                      <div className="min-w-0">
                        <Textarea aria-label="Paragraph text" rows={2} className="min-h-12" value={para.text} onChange={(e) => update({ text: e.target.value })} />
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          <NativeSelect aria-label="Voice for this paragraph" className="h-7 w-auto max-w-56 text-[12px]" value={para.voice ?? ""} onChange={(e) => update({ voice: e.target.value || null })}>
                            <option value="">project voice</option>
                            {(voices.data ?? []).map((v) => <option key={v.voice_id} value={v.voice_id}>{v.name || v.voice_id}</option>)}
                          </NativeSelect>
                          <NativeSelect aria-label="Style for this paragraph" className="h-7 w-auto max-w-44 text-[12px]" value={para.style ?? ""} onChange={(e) => update({ style: e.target.value || null })}>
                            <option value="">project style</option>
                            {(styles.data ?? []).map((s) => <option key={s.name} value={s.name}>{s.title || s.name}</option>)}
                          </NativeSelect>
                        </div>
                      </div>
                      <div className="flex items-start gap-0.5">
                        <Tooltip content="Play">
                          <Button size="icon-sm" variant="ghost" aria-label="Play paragraph" disabled={!srv?.render} onClick={() => para.id && play(para.id, api.paragraphAudioUrl(projectId, para.id))}>
                            {playing === para.id ? <Pause className="size-4" /> : <Play className="size-4" />}
                          </Button>
                        </Tooltip>
                        <Tooltip content={st === "draft" ? "Render" : "Render again"}>
                          <Button size="icon-sm" variant="ghost" aria-label="Render paragraph" loading={st === "working"} disabled={!para.id || !para.text.trim()} onClick={() => para.id && void renderOne(para.id)}>
                            {st === "draft" ? <Zap className="size-4" /> : <RotateCcw className="size-4" />}
                          </Button>
                        </Tooltip>
                        <Tooltip content="Takes and speech check">
                          <Button size="icon-sm" variant={para.id && openTakes.has(para.id) ? "soft" : "ghost"} aria-label="Takes" disabled={!srv?.render}
                            onClick={() => para.id && setOpenTakes((s) => { const n = new Set(s); if (n.has(para.id!)) n.delete(para.id!); else n.add(para.id!); return n; })}>
                            <Layers className="size-4" />
                          </Button>
                        </Tooltip>
                        <Tooltip content={srv?.locked ? "Unlock" : "Lock: skip when rendering what changed"}>
                          <Button size="icon-sm" variant="ghost" aria-label={srv?.locked ? "Unlock paragraph" : "Lock paragraph"} disabled={!para.id}
                            onClick={async () => { if (!para.id) return; try { apply(await api.lockParagraph(projectId, para.id, !srv?.locked)); } catch (e) { toast.error(errMessage(e)); } }}>
                            {srv?.locked ? <Lock className="size-4 text-fire" /> : <LockOpen className="size-4" />}
                          </Button>
                        </Tooltip>
                        <Tooltip content="Delete paragraph">
                          <Button size="icon-sm" variant="ghost" aria-label="Delete paragraph"
                            onClick={() => void structural(draft.map((c, i) => (i === ci ? { ...c, paragraphs: c.paragraphs.filter((_, j) => j !== pi) } : c)))}>
                            <Trash2 className="size-4" />
                          </Button>
                        </Tooltip>
                      </div>
                      {para.id && openTakes.has(para.id) && srv?.render && (
                        <div className="md:col-span-3">
                          <TakesPanel renderId={srv.render.id} format="mp3" onAudio={() => void qc.invalidateQueries({ queryKey: qk.project(projectId) })} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="px-4 py-2.5">
                <Button size="sm" variant="ghost" leading={<Plus className="size-4" />}
                  onClick={() => void structural(draft.map((c, i) => (i === ci ? { ...c, paragraphs: [...c.paragraphs, { text: "" }] } : c)))}>Add paragraph</Button>
              </div>
            </Card>
          );
        })}
        <Button variant="outline" leading={<Plus className="size-4" />}
          onClick={() => void structural([...draft, { title: `Chapter ${draft.length + 1}`, paragraphs: [{ text: "" }] }])}>Add chapter</Button>
      </div>
    </div>
  );
}

function CheckCard({ check }: { check: AudiobookCheck }) {
  const cols = check.chapters.find((c) => c.checks.length)?.checks ?? [];
  return (
    <Card className="mb-4 overflow-x-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold text-ink">Audiobook check</h3>
        <Badge tone={check.pass ? "ok" : "warn"}>{check.pass ? "every chapter passes" : "some checks fail"}</Badge>
        <span className="text-[12px] text-muted">{check.master ? "with the audiobook master" : "as rendered; turn on Audiobook master to fix loudness and peaks on export"}</span>
      </div>
      <table className="w-full text-left text-[13px]">
        <thead><tr className="text-muted"><th className="py-1 pr-3 font-medium">Chapter</th>{cols.map((x) => <th key={x.name} className="py-1 pr-3 font-medium">{x.name}<div className="text-[11px]">{x.target}</div></th>)}</tr></thead>
        <tbody>
          {check.chapters.map((c) => (
            <tr key={c.chapter} className="border-t border-line">
              <td className="py-1.5 pr-3 text-ink">{c.title}</td>
              {c.checks.length ? c.checks.map((x) => <td key={x.name} className="py-1.5 pr-3"><Badge tone={x.ok ? "ok" : "bad"}>{x.value} {x.unit}</Badge></td>)
                : <td colSpan={cols.length || 1} className="py-1.5 text-muted">{c.note}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
