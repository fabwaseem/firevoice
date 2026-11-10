import { useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, FileAudio, Mic, Pause, Play, Shuffle, Sparkles, Upload, Wand2, X } from "lucide-react";
import { api } from "@/lib/api/client";
import { errMessage, useAddVoice, useDesignVoice, useEngines, useOptions } from "@/lib/api/hooks";
import type { DesignBatch, Voice } from "@/lib/api/types";
import { cn, fmtBytes, langName } from "@/lib/utils";
import { Button, Chip, Dialog, Input, Label, NativeSelect, Segmented, Select, Textarea } from "@/components/ui";
import { RecordPanel } from "./RecordPanel";
import { DESIGN_EXAMPLES, GENDERS } from "./helpers";

const LANGS = ["en", "ur", "hi", "ar", "zh", "ja", "ko", "de", "fr", "es", "it", "pt", "ru", "tr"];
export type NewVoiceMode = "upload" | "record" | "design";

/**
 * One window for every new voice, in two steps.
 *   1. The voice itself: upload a clip, record one, or design it from a description.
 *   2. Its details: name and the rest; for a design, hear three versions and keep one, or create it directly.
 * Every new voice is saved to Voices; `onCreated` lets the opener use it straight away (Speak selects it).
 */
export function NewVoiceDialog({
  open,
  onOpenChange,
  initialMode = "upload",
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialMode?: NewVoiceMode;
  onCreated?: (voice: Voice) => void;
}) {
  const qc = useQueryClient();
  const add = useAddVoice();
  const design = useDesignVoice();
  const options = useOptions();
  const engines = useEngines();

  const [step, setStep] = useState<1 | 2>(1);
  const [mode, setMode] = useState<NewVoiceMode>(initialMode);
  // step 1
  const [file, setFile] = useState<File | null>(null);
  const [recording, setRecording] = useState<Blob | null>(null);
  const [transcript, setTranscript] = useState("");
  const [prompt, setPrompt] = useState("");
  const [engine, setEngine] = useState("");
  const [sample, setSample] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // step 2
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [gender, setGender] = useState("");
  const [language, setLanguage] = useState("en");
  const [accent, setAccent] = useState("");
  const [tags, setTags] = useState("");
  const [clean, setClean] = useState<"" | "light" | "medium" | "strong" | "neural">("medium");
  const [consent, setConsent] = useState(false);
  const [consentBy, setConsentBy] = useState("");
  // design versions
  const [batch, setBatch] = useState<DesignBatch | null>(null);
  const [trying, setTrying] = useState(false);
  const [keeping, setKeeping] = useState<number | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const languages = Array.from(new Set([...(options.data?.languages ?? []), ...LANGS]));
  const designEngines = useMemo(() => (engines.data ?? []).filter((e) => e.design && e.ready), [engines.data]);
  const engineValue = engine || designEngines[0]?.name || "";
  const audio = mode === "upload" ? file : mode === "record" ? recording : null;
  const isDesign = mode === "design";

  const canNext = isDesign ? prompt.trim().length > 12 && !!engineValue : !!audio;
  const canCreate = name.trim().length > 0 && (isDesign ? !design.isPending : consent && !add.isPending);

  const stopPreview = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  };
  const reset = () => {
    stopPreview();
    setStep(1);
    setFile(null);
    setRecording(null);
    setTranscript("");
    setPrompt("");
    setSample("");
    setName("");
    setDescription("");
    setGender("");
    setAccent("");
    setTags("");
    setConsent(false);
    setConsentBy("");
    setBatch(null);
  };
  const close = (v: boolean) => {
    if (!v) stopPreview();
    onOpenChange(v);
  };
  const done = (v: Voice | null) => {
    if (v) onCreated?.(v);
    reset();
    onOpenChange(false);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f && (f.type.startsWith("audio/") || /\.(wav|mp3|flac|ogg|opus|m4a|webm)$/i.test(f.name))) setFile(f);
  };

  // ---- create
  const createClone = () => {
    if (!audio) return;
    const fd = new FormData();
    fd.append("file", audio, audio instanceof File ? audio.name : "recording.webm");
    fd.append("name", name.trim());
    fd.append("consent", "true");
    if (consentBy.trim()) fd.append("consent_by", consentBy.trim());
    if (description) fd.append("description", description);
    if (gender) fd.append("gender", gender);
    if (language) fd.append("language", language);
    if (accent) fd.append("accent", accent);
    if (tags) fd.append("tags", tags);
    if (transcript) fd.append("transcript", transcript);
    if (clean) fd.append("clean", clean);
    add.mutate(fd, {
      onSuccess: (v) => {
        const q = v.quality_check?.after ?? v.quality_check?.before;
        if (q && q.verdict !== "good") toast.warning(`Clip quality: ${q.verdict}`, { description: q.notes.join("; ") });
        done(v);
      },
    });
  };
  const createDesign = () => {
    design.mutate(
      { name: name.trim(), description: prompt.trim(), engine: engineValue, gender: gender || undefined, language: language || undefined, text: sample.trim() || undefined },
      {
        onSuccess: (job) => {
          if (onCreated) void followDesign(job.id, onCreated, () => qc.invalidateQueries({ queryKey: ["voices"] }));
          done(null);
        },
      },
    );
  };
  const tryVersions = async () => {
    setTrying(true);
    stopPreview();
    try {
      setBatch(await api.designCandidates({ description: prompt.trim(), n: 3, engine: engineValue || undefined, text: sample.trim() || undefined }));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setTrying(false);
    }
  };
  const keep = async (n: number) => {
    if (!batch) return;
    if (!name.trim()) return toast.error("Give the voice a name first");
    setKeeping(n);
    try {
      const v = await api.keepDesignCandidate(batch.batch, n, { name: name.trim(), gender: gender || undefined, language: language || undefined });
      toast.success(`Saved “${v.name || v.voice_id}” to Voices`);
      qc.invalidateQueries({ queryKey: ["voices"] });
      done(v);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setKeeping(null);
    }
  };
  const preview = (n: number) => {
    if (!batch) return;
    if (playing === n) return stopPreview();
    audioRef.current?.pause();
    const a = new Audio(api.designCandidateUrl(batch.batch, n));
    a.onended = () => setPlaying(null);
    audioRef.current = a;
    setPlaying(n);
    a.play().catch(() => {
      setPlaying(null);
      toast.error("Could not play this version");
    });
  };

  const title = step === 1 ? "New voice" : isDesign ? "Name your designed voice" : "About this voice";
  const subtitle =
    step === 1
      ? "Clone a voice from a short clip, or design one from a description."
      : isDesign
        ? "Hear three versions and keep the one you like, or create it straight away."
        : "A name is all it needs; the rest helps you find it later.";

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={
        <span className="flex items-center gap-2.5">
          {title}
          <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-semibold text-muted tabular">Step {step} of 2</span>
        </span>
      }
      description={subtitle}
      size="md"
      footer={
        step === 1 ? (
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!canNext} onClick={() => setStep(2)} trailing={<ArrowRight className="size-4" />}>
              Next
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep(1)} leading={<ArrowLeft className="size-4" />}>
              Back
            </Button>
            <div className="flex-1" />
            {isDesign ? (
              <>
                <Button variant="outline" onClick={tryVersions} disabled={!canNext || trying} loading={trying} leading={<Shuffle className="size-4" />}>
                  {batch ? "Try again" : "Hear 3 versions"}
                </Button>
                <Button variant="primary" onClick={createDesign} disabled={!canCreate} loading={design.isPending} leading={<Sparkles className="size-4" />}>
                  Create voice
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={createClone} disabled={!canCreate} loading={add.isPending}>
                Add voice
              </Button>
            )}
          </>
        )
      }
    >
      <div key={step} className="fade-up">
        {step === 1 ? (
          <div className="flex flex-col gap-4">
            <Segmented
              value={mode}
              onChange={(m) => {
                setMode(m);
                setBatch(null);
              }}
              ariaLabel="How to make the voice"
              className="self-start"
              options={[
                { value: "upload", label: "Upload", icon: <Upload className="size-4" /> },
                { value: "record", label: "Record", icon: <Mic className="size-4" /> },
                { value: "design", label: "Design", icon: <Wand2 className="size-4" /> },
              ]}
            />

            {mode === "upload" && (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={cn(
                  "flex min-h-[188px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center transition-colors",
                  dragging ? "border-fire bg-fire-soft" : "border-line-strong bg-surface-2",
                )}
              >
                <input ref={fileInput} type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.opus,.m4a,.webm" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                {file ? (
                  <>
                    <FileAudio className="size-8 text-fire" />
                    <p className="text-[14px] font-medium text-ink">{file.name}</p>
                    <p className="text-[12px] text-muted">{fmtBytes(file.size)}</p>
                    <button type="button" onClick={() => setFile(null)} className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">
                      <X className="size-3.5" /> Remove
                    </button>
                  </>
                ) : (
                  <>
                    <Upload className="size-8 text-muted" />
                    <p className="text-[14px] font-medium text-ink">Drop a 7 to 14 second clip here</p>
                    <p className="text-[12px] text-muted">One speaker, little background noise. WAV, MP3, FLAC, M4A…</p>
                    <Button size="sm" className="mt-1" onClick={() => fileInput.current?.click()}>
                      Choose file
                    </Button>
                  </>
                )}
              </div>
            )}
            {mode === "record" && <RecordPanel value={recording} onChange={setRecording} />}
            {mode !== "design" && (
              <div>
                <Label htmlFor="nv-transcript" hint="optional">
                  What is said in the clip
                </Label>
                <Textarea id="nv-transcript" value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="Leave empty and FireVoice writes it down for you." className="min-h-[72px]" />
              </div>
            )}

            {mode === "design" && (
              <>
                <div>
                  <Label htmlFor="nv-prompt" hint={prompt.trim().length > 12 ? undefined : "a sentence or two"}>
                    Describe the voice
                  </Label>
                  <Textarea
                    id="nv-prompt"
                    autoFocus
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Age, tone, texture, energy, accent, and where you would hear this voice…"
                    className="min-h-[110px]"
                  />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {DESIGN_EXAMPLES.map((ex) => (
                      <Chip key={ex} onClick={() => setPrompt(ex)} className="h-7 max-w-full text-[12px]">
                        <span className="truncate">{ex.split(" ").slice(0, 6).join(" ")}…</span>
                      </Chip>
                    ))}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>Engine</Label>
                    {designEngines.length ? (
                      <Select
                        value={engineValue}
                        onChange={setEngine}
                        options={designEngines.map((e) => ({ value: e.name, label: e.title, description: [e.tier?.quality, e.tier?.speed].filter(Boolean).join(" · ") }))}
                        ariaLabel="Design engine"
                      />
                    ) : (
                      <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
                        No engine that designs voices is installed. See <Link to="/engines" className="text-fire hover:underline">Engines</Link>.
                      </p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="nv-sample" hint="optional">
                      Sample sentence
                    </Label>
                    <Input id="nv-sample" value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Leave empty for the standard one" />
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {isDesign && batch && (
              <div className="rounded-xl border border-line bg-surface-2 p-2">
                <p className="px-2 pt-1 pb-2 text-[12.5px] font-medium text-ink">Pick the version you like</p>
                {batch.candidates.map((c) => (
                  <div key={c.n} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-surface-3/60">
                    <Button size="icon-sm" variant={playing === c.n ? "soft" : "ghost"} aria-label={`Play version ${c.n}`} onClick={() => preview(c.n)}>
                      {playing === c.n ? <Pause className="size-4" /> : <Play className="size-4" />}
                    </Button>
                    <span className="text-[13px] text-ink">Version {c.n}</span>
                    <span className="text-[12px] text-muted">{c.duration}s</span>
                    <div className="flex-1" />
                    <Button size="sm" variant="primary" onClick={() => void keep(c.n)} loading={keeping === c.n} disabled={!name.trim()}>
                      Keep this one
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div>
              <Label htmlFor="nv-name">Name</Label>
              <Input id="nv-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={isDesign ? "e.g. Ghost narrator" : "e.g. Studio narrator"} />
            </div>
            {!isDesign && (
              <div>
                <Label htmlFor="nv-desc" hint="optional">
                  Description
                </Label>
                <Input id="nv-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="warm, mid-forties, slight gravel" />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Gender</Label>
                <Select value={gender} onChange={setGender} options={GENDERS} ariaLabel="Gender" />
              </div>
              <div>
                <Label>Language</Label>
                <Select value={language} onChange={setLanguage} options={languages.map((l) => ({ value: l, label: langName(l) }))} ariaLabel="Language" />
              </div>
            </div>
            {!isDesign && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="nv-accent" hint="optional">
                      Accent
                    </Label>
                    <Input id="nv-accent" value={accent} onChange={(e) => setAccent(e.target.value)} placeholder="Scottish, General American…" />
                  </div>
                  <div>
                    <Label htmlFor="nv-tags" hint="optional">
                      Tags
                    </Label>
                    <Input id="nv-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="mine, studio" />
                  </div>
                </div>
                <div>
                  <Label htmlFor="nv-clean" hint="takes out hiss, hum and room noise">
                    Clean the clip
                  </Label>
                  <NativeSelect id="nv-clean" value={clean} onChange={(e) => setClean(e.target.value as typeof clean)}>
                    <option value="">No, use it as recorded</option>
                    <option value="light">Light</option>
                    <option value="medium">Medium</option>
                    <option value="strong">Strong</option>
                    <option value="neural">Best (needs Crucible from Engines)</option>
                  </NativeSelect>
                </div>
                <div>
                  <Label htmlFor="nv-consent-by" hint="kept with the voice">
                    Who gave permission
                  </Label>
                  <Input id="nv-consent-by" value={consentBy} onChange={(e) => setConsentBy(e.target.value)} placeholder="The speaker's name" />
                </div>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-surface-2 p-3 text-[12.5px] text-ink-2">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4 accent-[var(--fire)]" />
                  <span>
                    <span className="font-medium text-ink">I own this voice or have permission to clone it.</span> Only clone voices you have the right to use.
                  </span>
                </label>
              </>
            )}
            {isDesign && !batch && (
              <p className="text-[12px] text-muted">
                Create voice makes it in the background; it appears in Voices when ready. Hear 3 versions first to choose the one you like.
              </p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Wait for a background design job; hand over the new voice when it is saved. */
async function followDesign(jobId: string, onCreated: (v: Voice) => void, refresh: () => void) {
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let job;
    try {
      job = await api.job(jobId);
    } catch {
      continue;
    }
    if (job.status === "done") {
      const v = (job.result as { voice?: { voice_id?: string } } | undefined)?.voice;
      refresh();
      if (v?.voice_id) {
        const voice = await api.voice(v.voice_id).catch(() => null);
        if (voice) {
          onCreated(voice);
          toast.success(`“${voice.name}” is ready and selected`);
        }
      }
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") return;
  }
}
