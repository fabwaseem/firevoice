import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, FileText, Mic2, Palette, Plus, Type, Upload } from "lucide-react";
import { api } from "@/lib/api/client";
import { errMessage, qk, useOptions, useProjects, useStyles, useVoices } from "@/lib/api/hooks";
import type { ProjectSummary } from "@/lib/api/types";
import { useStudio } from "@/stores/studio";
import { PageHeader, LoadError } from "@/components/shell/PageHeader";
import { Badge, Button, Card, Dialog, EmptyState, Input, Label, NativeSelect, Skeleton, Textarea } from "@/components/ui";
import { fmtTime, relTime } from "@/lib/utils";

const SAMPLE_BOOK = `# Chapter One
The keeper climbed the stairs every evening at dusk, one hundred and twelve of them, counting each step out loud.

At the top, he trimmed the wick, wiped the great lens, and waited for the first ship of the night.

# Chapter Two
The fog came in early that October. By midnight the lamp was the only thing left in the world.

Far out on the water, a bell answered.`;

/** Long-form projects: audiobooks, courses and series. */
export function ProjectsView() {
  const q = useProjects();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const importBundle = async (f: File) => {
    try {
      const p = await api.importProject(f);
      toast.success(`Imported ${p.title}`);
      qc.invalidateQueries({ queryKey: qk.projects });
      navigate(`/projects/${p.id}`);
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Projects"
        subtitle="Audiobooks, courses and series: chapters of paragraphs, each with its own takes. Render only what changed, export with chapters."
        actions={
          <>
            <Button variant="outline" leading={<Upload className="size-4" />} onClick={() => fileRef.current?.click()}>Import bundle</Button>
            <Button variant="primary" leading={<Plus className="size-4" />} onClick={() => setOpen(true)}>New project</Button>
          </>
        }
      />
      <input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void importBundle(f); e.target.value = ""; }} />
      {q.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}</div>
      ) : q.isError ? (
        <LoadError message={errMessage(q.error)} retry={() => void q.refetch()} />
      ) : q.data && q.data.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {q.data.map((p) => <ProjectCard key={p.id} p={p} onOpen={() => navigate(`/projects/${p.id}`)} />)}
        </div>
      ) : (
        <EmptyState icon={<BookOpen className="size-5" />} title="No projects yet"
          description="Paste a whole script: heading lines start chapters, blank lines split paragraphs."
          action={<Button variant="primary" leading={<Plus className="size-4" />} onClick={() => setOpen(true)}>New project</Button>} />
      )}
      <NewProjectDialog open={open} onOpenChange={setOpen} onCreated={(id) => navigate(`/projects/${id}`)} />
    </div>
  );
}

function ProjectCard({ p, onOpen }: { p: ProjectSummary; onOpen: () => void }) {
  const n = Math.max(1, p.paragraphs ?? 0);
  // older servers may leave counts out
  const c = (p.counts ?? {}) as Partial<Record<string, number>>;
  const counts = { rendered: c.rendered ?? 0, locked: c.locked ?? 0, stale: c.stale ?? 0, draft: c.draft ?? 0 };
  const ready = counts.rendered + counts.locked;
  return (
    <button type="button" onClick={onOpen} className="text-left">
      <Card className="h-full p-4 transition-colors hover:border-fire">
        <h3 className="truncate text-[16px] font-semibold text-ink">{p.title}</h3>
        <p className="mt-1 text-[12.5px] text-muted">{p.chapters} chapter{p.chapters === 1 ? "" : "s"} · {p.paragraphs} paragraphs · {p.words} words</p>
        <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-surface-3">
          <span className="bg-ok" style={{ width: `${(100 * ready) / n}%` }} />
          <span className="bg-warn" style={{ width: `${(100 * counts.stale) / n}%` }} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px]">
          <Badge tone="ok">{ready} ready</Badge>
          {counts.stale > 0 && <Badge tone="warn">{counts.stale} changed</Badge>}
          {counts.draft > 0 && <Badge>{counts.draft} draft</Badge>}
          <Badge>{fmtTime(p.duration)}</Badge>
          <span className="text-muted">edited {relTime(p.updated)}</span>
        </div>
      </Card>
    </button>
  );
}

function NewProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (id: string) => void }) {
  const studioVoice = useStudio((s) => s.voice);
  const studioEngine = useStudio((s) => s.engine);
  const voices = useVoices();
  const styles = useStyles();
  const options = useOptions();
  const qc = useQueryClient();
  const [title, setTitle] = useState("The Lighthouse Keeper");
  const [text, setText] = useState(SAMPLE_BOOK);
  const [voice, setVoice] = useState(studioVoice);
  const [style, setStyle] = useState("audiobook");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const p = await api.createProject({ title: title.trim() || "Untitled project", text, defaults: { voice, style, engine: studioEngine ?? options.data?.default_engine } });
      qc.invalidateQueries({ queryKey: qk.projects });
      onOpenChange(false);
      setTitle("");
      setText("");
      onCreated(p.id);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New project" size="lg"
      description='Paste a whole script if you have one: "# Title" or "Chapter 1" lines start chapters, blank lines split paragraphs.'
      footer={<>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" leading={<Plus className="size-4" />} loading={busy} onClick={create}>Create</Button>
      </>}>
      <div className="space-y-3">
        <div><Label htmlFor="np-title" icon={<Type />}>Title</Label><Input id="np-title" value={title} placeholder="The Lighthouse Keeper" onChange={(e) => setTitle(e.target.value)} /></div>
        <div><Label htmlFor="np-text" icon={<FileText />}>Script</Label>
          <Textarea id="np-text" rows={10} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={"# Chapter One\nThe keeper climbed the stairs every evening at dusk.\n\nHe counted each step out loud..."} /></div>
        <div className="grid gap-3 md:grid-cols-2">
          <div><Label icon={<Mic2 />}>Voice</Label>
            <NativeSelect value={voice} onChange={(e) => setVoice(e.target.value)}>
              <option value="default">Default voice</option>
              {(voices.data ?? []).map((v) => <option key={v.voice_id} value={v.voice_id}>{v.name || v.voice_id}{v.tagline ? ` · ${v.tagline}` : ""}</option>)}
            </NativeSelect></div>
          <div><Label icon={<Palette />}>Style</Label>
            <NativeSelect value={style} onChange={(e) => setStyle(e.target.value)}>
              {(styles.data ?? []).map((s) => <option key={s.name} value={s.name}>{s.title || s.name}</option>)}
            </NativeSelect></div>
        </div>
      </div>
    </Dialog>
  );
}
