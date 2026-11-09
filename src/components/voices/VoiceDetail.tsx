import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { AudioLines, Pause, Play, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Voice } from "@/lib/api/types";
import { api } from "@/lib/api/client";
import { errMessage, useDeleteVoice, useSetDefaultVoice, useUpdateVoice, useVoice } from "@/lib/api/hooks";
import { usePlayer } from "@/stores/player";
import { useStudio } from "@/stores/studio";
import { cn, fmtDuration, langName, relTime } from "@/lib/utils";
import { ArtTile, Badge, Button, ConfirmDialog, Dialog, Equalizer, Input, Label, Select, Skeleton, Textarea } from "@/components/ui";
import { GENDERS, genderLabel, initials, parseTags } from "./helpers";

export function VoiceDetail({ voiceId, onClose }: { voiceId: string | null; onClose: () => void }) {
  const { data: voice, isLoading, error } = useVoice(voiceId);
  return (
    <Dialog open={!!voiceId} onOpenChange={(o) => !o && onClose()} title={voice?.name ?? "Voice"} description={voice ? voice.voice_id : undefined} size="lg">
      {isLoading && <DetailSkeleton />}
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {errMessage(error)}
        </p>
      )}
      {voice && <DetailBody voice={voice} onClose={onClose} />}
    </Dialog>
  );
}

function DetailBody({ voice, onClose }: { voice: Voice; onClose: () => void }) {
  const navigate = useNavigate();
  const update = useUpdateVoice();
  const setDefault = useSetDefaultVoice();
  const del = useDeleteVoice();
  const player = usePlayer();
  const setStudio = useStudio((s) => s.set);

  const [name, setName] = useState(voice.name);
  const [description, setDescription] = useState(voice.description ?? "");
  const [gender, setGender] = useState(voice.gender ?? "");
  const [accent, setAccent] = useState(voice.accent ?? "");
  const [tags, setTags] = useState((voice.tags ?? []).join(", "));
  const [notes, setNotes] = useState(voice.notes ?? "");
  const [transcript, setTranscript] = useState(voice.transcript ?? "");
  const [savingTranscript, setSavingTranscript] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(voice.name);
    setDescription(voice.description ?? "");
    setGender(voice.gender ?? "");
    setAccent(voice.accent ?? "");
    setTags((voice.tags ?? []).join(", "));
    setNotes(voice.notes ?? "");
    setTranscript(voice.transcript ?? "");
  }, [voice]);

  const dirty =
    name !== voice.name ||
    description !== (voice.description ?? "") ||
    gender !== (voice.gender ?? "") ||
    accent !== (voice.accent ?? "") ||
    tags !== (voice.tags ?? []).join(", ") ||
    notes !== (voice.notes ?? "");

  const save = () =>
    update.mutate(
      { id: voice.voice_id, patch: { name: name.trim() || voice.name, description, gender, accent, tags: parseTags(tags), notes } },
      { onSuccess: () => toast.success("Voice saved") },
    );

  const saveTranscript = async () => {
    setSavingTranscript(true);
    try {
      await api.setTranscript(voice.voice_id, transcript);
      toast.success("Transcript saved");
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setSavingTranscript(false);
    }
  };

  const playClip = (style?: string) => {
    const id = style ? `${voice.voice_id}:${style}` : voice.voice_id;
    if (player.track?.id === id) return player.toggle();
    player.load({ id, title: voice.name, subtitle: style ? `${style} reference clip` : "Reference clip", src: api.voiceAudioUrl(voice.voice_id, style), format: "wav", href: `/voices/${voice.voice_id}` });
  };
  const isPlaying = (id: string) => player.track?.id === id && player.playing;

  const useInSpeak = () => {
    setStudio({ voice: voice.voice_id });
    onClose();
    navigate("/speak");
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          <ArtTile seed={voice.voice_id} className="size-24 text-[26px] font-bold">
            {isPlaying(voice.voice_id) ? <Equalizer className="h-6 text-white" /> : initials(voice.name)}
          </ArtTile>
          {voice.has_ref !== false && (
            <button
              type="button"
              onClick={() => playClip()}
              aria-label={isPlaying(voice.voice_id) ? "Pause reference" : "Play reference"}
              className="absolute -right-2 -bottom-2 flex size-9 items-center justify-center rounded-full bg-white text-ink shadow-md hover:scale-105"
            >
              {isPlaying(voice.voice_id) ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
            </button>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={voice.kind === "designed" ? "info" : "neutral"}>{voice.kind}</Badge>
            <Badge>{langName(voice.language)}</Badge>
            {voice.gender && <Badge>{genderLabel(voice.gender)}</Badge>}
            {voice.default && (
              <Badge tone="fire">
                <Star className="size-3 fill-current" /> default
              </Badge>
            )}
            {voice.license && <Badge>{voice.license}</Badge>}
          </div>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
            {voice.source && <Row k="Source" v={voice.source} />}
            {voice.ref_seconds != null && <Row k="Reference" v={fmtDuration(voice.ref_seconds)} />}
            {voice.created && <Row k="Added" v={relTime(voice.created)} />}
            {voice.design_prompt && <Row k="Prompt" v={voice.design_prompt} />}
          </dl>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" leading={<AudioLines className="size-4" />} onClick={useInSpeak}>
          Use in Speak
        </Button>
        <Button leading={<Star className={cn("size-4", voice.default && "fill-current text-fire")} />} disabled={voice.default || setDefault.isPending} onClick={() => setDefault.mutate(voice.voice_id)}>
          {voice.default ? "Default voice" : "Set as default"}
        </Button>
        <Button variant="danger" leading={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)} className="ml-auto">
          Delete
        </Button>
      </div>

      <section className="grid gap-3 rounded-xl border border-line bg-surface-2 p-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Label htmlFor="vd-name">Name</Label>
          <Input id="vd-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="vd-desc">Description</Label>
          <Input id="vd-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="How this voice sounds" />
        </div>
        <div>
          <Label>Gender</Label>
          <Select value={gender} onChange={setGender} options={GENDERS} ariaLabel="Gender" />
        </div>
        <div>
          <Label htmlFor="vd-accent">Accent</Label>
          <Input id="vd-accent" value={accent} onChange={(e) => setAccent(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="vd-tags" hint="comma separated">
            Tags
          </Label>
          <Input id="vd-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="vd-notes">Notes</Label>
          <Textarea id="vd-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-[60px]" />
        </div>
        <div className="flex justify-end md:col-span-2">
          <Button variant="secondary" size="sm" disabled={!dirty} loading={update.isPending} onClick={save}>
            Save changes
          </Button>
        </div>
      </section>

      {voice.kind === "cloned" && (
        <section>
          <Label htmlFor="vd-transcript" hint="used by in-context cloning engines">
            Transcript
          </Label>
          <Textarea id="vd-transcript" value={transcript} onChange={(e) => setTranscript(e.target.value)} className="min-h-[72px]" />
          <div className="mt-2 flex justify-end">
            <Button size="sm" disabled={transcript === (voice.transcript ?? "")} loading={savingTranscript} onClick={saveTranscript}>
              Save transcript
            </Button>
          </div>
        </section>
      )}

      <section>
        <Label hint={`${voice.styles?.length ?? 0} clips`}>Per-style reference clips</Label>
        {voice.styles?.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {voice.styles.map((s) => {
              const id = `${voice.voice_id}:${s}`;
              return (
                <li key={s} className="flex items-center justify-between gap-3 bg-surface px-3 py-2">
                  <span className="text-[13px] font-medium text-ink">{s}</span>
                  <Button variant="ghost" size="icon-sm" aria-label={isPlaying(id) ? `Pause ${s} clip` : `Play ${s} clip`} onClick={() => playClip(s)}>
                    {isPlaying(id) ? <Pause className="size-4" /> : <Play className="size-4" />}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-line-strong px-3 py-3 text-[12.5px] text-muted">
            None yet. Add one from the CLI: <code className="font-mono text-[12px]">firevoice voices style-ref --name {voice.name} --style-name horror --ref clip.wav</code>
          </p>
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${voice.name}”?`}
        description="The reference clip, transcript and per-style clips are removed from the library. Renders already made with it are kept."
        confirmLabel="Delete voice"
        destructive
        loading={del.isPending}
        onConfirm={() =>
          del.mutate(voice.voice_id, {
            onSuccess: () => {
              setConfirmDelete(false);
              onClose();
            },
          })
        }
      />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="truncate text-ink-2" title={v}>
        {v}
      </dd>
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy>
      <div className="flex gap-4">
        <Skeleton className="size-24 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}
