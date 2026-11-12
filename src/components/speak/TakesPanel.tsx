import { QualityView } from "@/components/tools/QualityReport";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Captions, Gauge, ListOrdered, Lock, LockOpen, PencilLine, Plus, RefreshCw, Scissors, Shuffle } from "@/components/icons";
import { api } from "@/lib/api/client";
import { errMessage, qk, useKeptRender } from "@/lib/api/hooks";
import type { KeptRender, QualityReport, RenderChunk, RenderTake, WordTime } from "@/lib/api/types";
import { saveBlob } from "@/lib/audio";
import { usePlayer } from "@/stores/player";
import { Badge, Button, Card, Dialog, Skeleton, Tooltip } from "@/components/ui";
import { cn } from "@/lib/utils";
import { WordDownloads } from "@/components/tools/WordDownloads";

/** Download subtitles for the result: from the kept render when there is one, else from the word times. */
export function SubtitleButtons({ renderId, words }: { renderId: string | null; words: WordTime[] }) {
  const save = async (format: "srt" | "vtt") => {
    try {
      const text = renderId ? await api.keptSubtitles(renderId, format) : await api.subtitles(words, format);
      await saveBlob(new Blob([text], { type: format === "vtt" ? "text/vtt" : "application/x-subrip" }), `firevoice-${renderId ?? "render"}.${format}`);
    } catch (e) {
      toast.error(errMessage(e));
    }
  };
  if (!words.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" leading={<Captions className="size-4" />} onClick={() => save("srt")}>Subtitles (SRT)</Button>
      <Button size="sm" variant="ghost" leading={<Captions className="size-4" />} onClick={() => save("vtt")}>Subtitles (VTT)</Button>
      {/* the kept render's own word times when there is one (they follow any take swapped in), else these */}
      <WordDownloads variant="ghost" baseName="speech" words={renderId ? async () => (await api.keptRenderWords(renderId)).words : words} />
    </div>
  );
}

/**
 * Every passage of a kept render: what the speech check heard (missed or misheard words underlined), each take to
 * compare, a new take, and a lock that keeps a passage when the rest are re-taken.
 */
export function TakesPanel({ renderId, format, onAudio }: {
  renderId: string;
  format: string;
  onAudio: (blob: Blob, format: string, words: WordTime[], duration: number) => void;
}) {
  const qc = useQueryClient();
  const q = useKeptRender(renderId);
  const [busy, setBusy] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityReport | null>(null);
  const [qBusy, setQBusy] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => audioRef.current?.pause(), []);

  const play = (index: number, n: number) => {
    const key = `${index}.${n}`;
    audioRef.current?.pause();
    if (playing === key) {
      setPlaying(null);
      return;
    }
    usePlayer.getState().setPlaying(false);
    const a = new Audio(api.takeAudioUrl(renderId, index, n));
    a.onended = () => setPlaying(null);
    audioRef.current = a;
    setPlaying(key);
    a.play().catch((e) => {
      setPlaying(null);
      toast.error(errMessage(e));
    });
  };

  const act = async (key: string, fn: () => Promise<KeptRender>, done?: string) => {
    setBusy(key);
    try {
      const m = await fn();
      qc.setQueryData(qk.kept(renderId), m);
      const [blob, w] = await Promise.all([api.keptRenderAudio(renderId, format), api.keptRenderWords(renderId)]);
      onAudio(blob, format, w.words, w.duration);
      if (done) toast.success(done);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (q.isLoading) return <Skeleton className="h-24" />;
  if (q.isError || !q.data) return null;
  const m = q.data;

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2"><ListOrdered className="size-4 shrink-0 text-fire" />Passages and takes</h3>
        <span className="text-[12.5px] text-muted">
          {m.chunks.length} passage{m.chunks.length === 1 ? "" : "s"}
        </span>
        {m.flagged ? <Badge tone="warn">{m.flagged} to check</Badge> : <Badge tone="ok">All passed the speech check</Badge>}
        <div className="flex-1" />
        <Tooltip content="How much it sounds like the voice, its sound quality, and how that holds over the whole render">
          <Button size="sm" variant="ghost" leading={<Gauge className="size-4" />} loading={qBusy} disabled={!!busy}
            onClick={async () => {
              setQBusy(true);
              try {
                setQuality(await api.renderQuality(renderId));
              } catch (e) {
                toast.error(errMessage(e));
              } finally {
                setQBusy(false);
              }
            }}>
            Quality
          </Button>
        </Tooltip>
        <Tooltip content="A new take for every passage that is not locked">
          <Button size="sm" variant="ghost" leading={<Shuffle className="size-4" />} loading={busy === "all"}
            onClick={() => act("all", () => api.regenerateUnlocked(renderId), "New takes for every unlocked passage")} disabled={!!busy}>
            Re-take unlocked
          </Button>
        </Tooltip>
      </div>
      <div className="space-y-1.5">
        {m.chunks.map((c) => (
          <PassageRow key={c.index} c={c} busy={busy} playing={playing} onPlay={play}
            onChoose={(n) => act(`c${c.index}`, () => api.chooseTake(renderId, c.index, n), `Passage ${c.index + 1} uses take ${n}`)}
            onNew={() => act(`n${c.index}`, () => api.newTake(renderId, c.index), `New take for passage ${c.index + 1}`)}
            onLock={() => act(`l${c.index}`, () => api.lockPassage(renderId, c.index, !c.locked))}
            onEdit={(text, mode) =>
              act(`e${c.index}`, async () => {
                const r = await api.editPassage(renderId, c.index, text, mode);
                const note = r.chunks.find((x) => x.index === c.index)?.takes.slice(-1)[0]?.edit?.note;
                if (note) toast(note);
                return r;
              }, mode === "splice" ? `Passage ${c.index + 1}: edited words spliced in` : `Passage ${c.index + 1} re-recorded`)
            } />
        ))}
      </div>
      <p className="mt-2 text-[12px] text-muted">Click a take to hear it, double-click to use it. Underlined words were missed or misheard by the speech check.</p>
      <Dialog open={!!quality} onOpenChange={(v) => !v && setQuality(null)} title="Quality report" size="lg">
        {quality && <QualityView r={quality} />}
      </Dialog>
    </Card>
  );
}

function PassageRow({ c, busy, playing, onPlay, onChoose, onNew, onLock, onEdit }: {
  c: RenderChunk;
  busy: string | null;
  playing: string | null;
  onPlay: (index: number, n: number) => void;
  onChoose: (n: number) => void;
  onNew: () => void;
  onLock: () => void;
  onEdit: (text: string, mode: "splice" | "passage") => void;
}) {
  const cur = c.takes.find((t) => t.n === c.chosen);
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const submit = (mode: "splice" | "passage") => {
    if (!draft || draft.trim() === c.text) return toast("Change some words first");
    onEdit(draft.trim(), mode);
    setDraft(null);
  };
  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border border-transparent bg-surface-2 px-3 py-2.5 md:flex-row md:items-start",
      c.flagged && "border-warn/40", c.locked && "opacity-85")}>
      <div className="min-w-0 flex-1 text-[14px] leading-relaxed text-ink-2">
        {editing ? (
          <div className="space-y-2">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setDraft(null);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit("splice");
              }}
              rows={2}
              className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[14px] text-ink outline-none focus:border-fire"
            />
            <div className="flex flex-wrap gap-2">
              <Tooltip content="Keep the original recording; only the words you changed are new (Ctrl+Enter)">
                <Button size="sm" onClick={() => submit("splice")} leading={<Scissors className="size-3.5" />}>Splice in</Button>
              </Tooltip>
              <Tooltip content="Use the whole re-recorded passage">
                <Button size="sm" variant="ghost" onClick={() => submit("passage")} leading={<RefreshCw className="size-3.5" />}>Re-record passage</Button>
              </Tooltip>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <QAText c={c} take={cur} />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {c.takes.map((t) => (
          <Tooltip key={t.n} content={`Take ${t.n}: score ${t.score}, ${t.duration}s, seed ${t.seed}${t.n === c.chosen ? " (in use)" : " (double-click to use)"}`}>
            <button type="button" onClick={() => onPlay(c.index, t.n)} onDoubleClick={() => onChoose(t.n)} disabled={!!busy}
              aria-label={`Play take ${t.n}`} aria-pressed={t.n === c.chosen}
              className={cn("h-7 min-w-7 rounded-[9px] border border-line bg-surface-3 px-1.5 text-[12.5px] font-bold text-ink-2 transition-colors hover:border-fire hover:text-ink",
                t.n === c.chosen && "border-fire bg-fire-soft text-fire", playing === `${c.index}.${t.n}` && "fire-gradient text-white")}>
              {t.n}
            </button>
          </Tooltip>
        ))}
        <Tooltip content={c.locked ? "Unlock the passage to edit it" : "Edit words: re-record only what you change"}>
          <Button size="icon-sm" variant="ghost" aria-label="Edit words" onClick={() => setDraft(c.text)} loading={busy === `e${c.index}`} disabled={!!busy || c.locked || editing}>
            <PencilLine className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content="New take of this passage">
          <Button size="icon-sm" variant="ghost" aria-label="New take" onClick={onNew} loading={busy === `n${c.index}`} disabled={!!busy}>
            <Plus className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content={c.locked ? "Unlock" : "Lock: keep this take when re-taking the rest"}>
          <Button size="icon-sm" variant="ghost" aria-label={c.locked ? "Unlock passage" : "Lock passage"} onClick={onLock} loading={busy === `l${c.index}`} disabled={!!busy}>
            {c.locked ? <Lock className="size-4 text-fire" /> : <LockOpen className="size-4" />}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

function QAText({ c, take }: { c: RenderChunk; take?: RenderTake }) {
  if (!take?.qa) return <>{c.text}</>;
  return (
    <>
      {take.qa.words.map((w, i) => (
        <span key={i}>
          {i > 0 && " "}
          {w.status === "ok" ? w.text : (
            <span title={w.status === "changed" ? `heard: ${w.heard}` : "not heard"}
              className={cn("cursor-help text-ink underline decoration-wavy underline-offset-4", w.status === "missed" ? "decoration-bad" : "decoration-warn")}>
              {w.text}
            </span>
          )}
        </span>
      ))}
      {take.qa.extra.length > 0 && <span className="ml-1 text-[12.5px] text-warn" title="heard but not in the script">+ {take.qa.extra.join(" ")}</span>}
    </>
  );
}
