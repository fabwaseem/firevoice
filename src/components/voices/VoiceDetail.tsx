import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { AudioLines, Hammer, ImageOff, ImagePlus, Pause, Play, Save, Star, Trash2, Undo2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import type { Voice } from "@/lib/api/types";
import { api } from "@/lib/api/client";
import { errMessage, useDeleteVoice, useSetDefaultVoice, useStyles, useUpdateVoice, useVoice } from "@/lib/api/hooks";
import { usePlayer } from "@/stores/player";
import { useStudio } from "@/stores/studio";
import { cn, fmtDuration, langName, relTime } from "@/lib/utils";
import { ArtTile, Badge, Button, ConfirmDialog, Dialog, Equalizer, Input, Label, Select, Skeleton, Textarea } from "@/components/ui";
import { GENDERS, genderLabel, initials, kindLabel, parseTags } from "./helpers";
import { QualityBadge } from "./QualityBadge";

export function VoiceDetail({ voiceId, onClose }: { voiceId: string | null; onClose: () => void }) {
  const { data: voice, isLoading, error } = useVoice(voiceId);
  return (
    <Dialog open={!!voiceId} onOpenChange={(o) => !o && onClose()} title={voice?.name ?? "Voice"} description={voice?.kind ? `${kindLabel(voice.kind)} voice` : undefined} size="lg">
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
  const styles = useStyles();
  const consent = useQuery({ queryKey: ["consent", voice.voice_id], queryFn: () => api.voiceConsent(voice.voice_id), retry: false, staleTime: 60_000 });
  const navigate = useNavigate();
  const update = useUpdateVoice();
  const setDefault = useSetDefaultVoice();
  const del = useDeleteVoice();
  const currentId = usePlayer((s) => s.track?.id);
  const playing = usePlayer((s) => s.playing);
  const setStudio = useStudio((s) => s.set);

  const [name, setName] = useState(voice.name);
  const [description, setDescription] = useState(voice.description ?? "");
  const [tagline, setTagline] = useState(voice.tagline ?? "");
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
    setTagline(voice.tagline ?? "");
    setGender(voice.gender ?? "");
    setAccent(voice.accent ?? "");
    setTags((voice.tags ?? []).join(", "));
    setNotes(voice.notes ?? "");
    setTranscript(voice.transcript ?? "");
  }, [voice]);

  const dirty =
    name !== voice.name ||
    description !== (voice.description ?? "") ||
    tagline !== (voice.tagline ?? "") ||
    gender !== (voice.gender ?? "") ||
    accent !== (voice.accent ?? "") ||
    tags !== (voice.tags ?? []).join(", ") ||
    notes !== (voice.notes ?? "");

  const save = () =>
    update.mutate(
      { id: voice.voice_id, patch: { name: name.trim() || voice.name, tagline, description, gender, accent, tags: parseTags(tags), notes } },
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
    const player = usePlayer.getState();
    if (player.track?.id === id) return player.toggle();
    const intro = !style && voice.has_preview;
    player.load({ id, title: voice.name, subtitle: style ? `${styleTitle(style)} style clip` : intro ? "Introduction" : "Reference clip",
      src: intro ? api.voicePreviewUrl(voice.voice_id) : api.voiceAudioUrl(voice.voice_id, style), format: intro ? "mp3" : "wav", href: `/voices/${voice.voice_id}` });
  };
  const isPlaying = (id: string) => currentId === id && playing;
  const styleTitle = (name: string) => (styles.data ?? []).find((s) => s.name === name)?.title || name;

  const useInSpeak = () => {
    setStudio({ voice: voice.voice_id });
    onClose();
    navigate("/speak");
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          <ArtTile seed={voice.voice_id} image={api.voiceAvatarUrl(voice)} className="size-24 text-[26px] font-bold">
            {isPlaying(voice.voice_id) ? <Equalizer className="h-6 text-white" /> : voice.avatar ? null : initials(voice.name)}
          </ArtTile>
          <AvatarButton voiceId={voice.voice_id} hasAvatar={!!voice.avatar} />
          {voice.has_ref !== false && (
            <button
              type="button"
              onClick={() => playClip()}
              aria-label={isPlaying(voice.voice_id) ? "Pause reference" : "Play reference"}
              className="absolute -right-2 -bottom-2 flex size-9 items-center justify-center rounded-full bg-white text-[#16171c] shadow-md hover:scale-105"
            >
              {isPlaying(voice.voice_id) ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
            </button>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {voice.tagline && <p className="mb-2 text-[14px] text-ink-2">{voice.tagline}</p>}
          <div className="flex flex-wrap items-center gap-1.5">
            <QualityBadge voice={voice} />
            {voice.kind && <Badge tone={voice.kind === "designed" ? "info" : "neutral"}>{kindLabel(voice.kind)}</Badge>}
            <Badge>{langName(voice.language)}</Badge>
            {voice.gender && <Badge>{genderLabel(voice.gender)}</Badge>}
            {voice.default && (
              <Badge tone="fire">
                <Star className="size-3 fill-current" /> Default
              </Badge>
            )}
          </div>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
            {voice.source && <Row k="Source" v={voice.source} />}
            {consent.data && (
              <Row
                k="Consent"
                v={
                  consent.data.basis === "consent"
                    ? [consent.data.by || "Given", consent.data.via, (consent.data.time || "").slice(0, 10)].filter(Boolean).join(" · ") + (consent.data.clip_note ? ` (${consent.data.clip_note})` : "")
                    : sentenceCase(consent.data.basis)
                }
              />
            )}
            {voice.ref_seconds != null && <Row k="Reference" v={fmtDuration(voice.ref_seconds)} />}
            {voice.created && <Row k="Added" v={relTime(voice.created)} />}
            {voice.design_prompt && <Row k="Prompt" v={voice.design_prompt} />}
            {!!voice.use_cases?.length && <Row k="Great for" v={voice.use_cases.join(", ")} />}
            {!!voice.traits?.length && <Row k="Sound" v={voice.traits.join(", ")} />}
          </dl>
        </div>
      </div>

      {voice.has_ref !== false && <ClipTools voice={voice} isPlaying={(s) => isPlaying(`${voice.voice_id}:${s}`)} onPlay={playClip} styleTitle={styleTitle} />}

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
          <Label htmlFor="vd-tagline" hint="shown under the name everywhere">
            Tagline
          </Label>
          <Input id="vd-tagline" value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="Warm, steady narrator with a Scottish accent" />
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
          <Button variant="secondary" size="sm" disabled={!dirty} loading={update.isPending} onClick={save} leading={<Save className="size-3.5" />}>
            Save changes
          </Button>
        </div>
      </section>

      {voice.kind === "cloned" && (
        <section>
          <Label htmlFor="vd-transcript" hint="the exact words spoken in the reference clip">
            Transcript
          </Label>
          <Textarea id="vd-transcript" value={transcript} onChange={(e) => setTranscript(e.target.value)} className="min-h-[72px]" />
          <div className="mt-2 flex justify-end">
            <Button size="sm" disabled={transcript === (voice.transcript ?? "")} loading={savingTranscript} onClick={saveTranscript} leading={<Save className="size-3.5" />}>
              Save transcript
            </Button>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${voice.name}”?`}
        description="The reference clip, transcript and style clips are removed from the library. Renders already made with it are kept."
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

/** "public-domain" -> "Public domain" */
function sentenceCase(s: string | undefined | null): string {
  const t = (s ?? "").replace(/[_-]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

const VERDICT: Record<string, string> = { good: "Good quality", fair: "Fair quality", poor: "Poor quality" };

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


/** Change the voice's avatar (any image, centre-cropped) or remove it. */
function AvatarButton({ voiceId, hasAvatar }: { voiceId: string; hasAvatar: boolean }) {
  const qc = useQueryClient();
  const ref = useRef<HTMLInputElement>(null);
  const done = () => {
    qc.invalidateQueries({ queryKey: ["voices"] });
    qc.invalidateQueries({ queryKey: ["voice", voiceId] });
  };
  return (
    <>
      <input ref={ref} type="file" accept="image/*" className="hidden" onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        try {
          await api.setVoiceAvatar(voiceId, f);
          toast.success("Avatar updated");
          done();
        } catch (err) {
          toast.error(errMessage(err));
        }
      }} />
      <button type="button" onClick={() => ref.current?.click()} aria-label="Change avatar"
        className="absolute -top-1.5 -left-1.5 flex size-7 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-sm hover:text-fire">
        <ImagePlus className="size-3.5" />
      </button>
      {hasAvatar && (
        <button type="button" aria-label="Remove avatar" className="absolute -bottom-1.5 -left-1.5 flex size-7 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-sm hover:text-bad"
          onClick={async () => { try { await api.removeVoiceAvatar(voiceId); done(); } catch (err) { toast.error(errMessage(err)); } }}>
          <ImageOff className="size-3.5" />
        </button>
      )}
    </>
  );
}


/** The reference clip's quality, cleaning, and the voice's own clip per style. */
function ClipTools({ voice, isPlaying, onPlay, styleTitle }: { voice: Voice; isPlaying: (style: string) => boolean; onPlay: (style: string) => void; styleTitle: (name: string) => string }) {
  const qc = useQueryClient();
  const styles = useStyles();
  const [strength, setStrength] = useState<"light" | "medium" | "strong" | "neural">("medium");
  const [busy, setBusy] = useState<string | null>(null);
  const [style, setStyle] = useState("");
  const q = voice.quality_check?.after ?? voice.quality_check?.before;
  const built = voice.styles ?? [];
  const buildable = (styles.data ?? []).filter((s) => s.instruct && !built.includes(s.name));
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["voices"] });
    qc.invalidateQueries({ queryKey: ["voice", voice.voice_id] });
  };
  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast.success(done);
      refresh();
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-ink">Reference clip</span>
        {q && <Badge tone={q.verdict === "good" ? "ok" : q.verdict === "poor" ? "bad" : "warn"}>{VERDICT[q.verdict] ?? sentenceCase(q.verdict)}</Badge>}
        {voice.quality_check?.cleaned && <Badge>Cleaned</Badge>}
        <div className="flex-1" />
        <Select value={strength} onChange={(v) => setStrength(v as typeof strength)} options={[{ value: "light", label: "Light" }, { value: "medium", label: "Medium" }, { value: "strong", label: "Strong" }, { value: "neural", label: "Deepest" }]} ariaLabel="Cleaning strength" />
        <Button size="sm" variant="outline" loading={busy === "clean"} onClick={() => act("clean", () => api.cleanVoice(voice.voice_id, strength), "Clip cleaned")} leading={<Wand2 className="size-3.5" />}>Clean</Button>
        <Button size="sm" variant="ghost" loading={busy === "restore"} onClick={() => act("restore", () => api.restoreVoice(voice.voice_id), "Original clip restored")} leading={<Undo2 className="size-3.5" />}>Restore original</Button>
      </div>
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-ink">Style clips <span className="font-normal text-muted">the voice's own take per style, so renders keep the voice and the delivery</span></p>
        <div className="flex flex-wrap items-center gap-1.5">
          {built.length ? built.map((s) => (
            <span key={s} className="inline-flex items-center gap-1 rounded-full bg-fire-soft px-2.5 py-1 text-[12px] text-fire">
              <button type="button" aria-label={isPlaying(s) ? `Pause ${styleTitle(s)} clip` : `Play ${styleTitle(s)} clip`} className="opacity-80 hover:opacity-100" onClick={() => onPlay(s)}>
                {isPlaying(s) ? <Pause className="size-3" /> : <Play className="size-3" />}
              </button>
              {styleTitle(s)}
              <button type="button" aria-label={`Remove ${styleTitle(s)} clip`} className="opacity-70 hover:opacity-100" onClick={() => act(`rm:${s}`, () => api.removeStyleClip(voice.voice_id, s))}>×</button>
            </span>
          )) : <span className="text-[12.5px] text-muted">None yet</span>}
        </div>
        {buildable.length > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <Select value={style || buildable[0].name} onChange={setStyle} options={buildable.map((s) => ({ value: s.name, label: s.title || s.name }))} />
            <Button size="sm" variant="outline" loading={busy === "build"}
              onClick={() => act("build", () => api.buildStyleClip(voice.voice_id, style || buildable[0].name), "Style clip built")} leading={<Hammer className="size-3.5" />}>Build clip</Button>
          </div>
        )}
      </div>
    </div>
  );
}
