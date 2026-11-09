import { toast } from "sonner";
import { useRef, useState, type DragEvent } from "react";
import { FileAudio, Mic, Upload, X } from "lucide-react";
import { useAddVoice, useOptions } from "@/lib/api/hooks";
import { cn, fmtBytes, langName } from "@/lib/utils";
import { Button, Dialog, Input, Label, Segmented, Select, Textarea , NativeSelect } from "@/components/ui";
import { RecordPanel } from "./RecordPanel";
import { GENDERS } from "./helpers";

const LANGS = ["en", "ur", "hi", "ar", "zh", "ja", "ko", "de", "fr", "es", "it", "pt", "ru", "tr"];

export function AddVoiceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const add = useAddVoice();
  const options = useOptions();
  const [mode, setMode] = useState<"upload" | "record">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [recording, setRecording] = useState<Blob | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [gender, setGender] = useState("");
  const [language, setLanguage] = useState("en");
  const [accent, setAccent] = useState("");
  const [tags, setTags] = useState("");
  const [transcript, setTranscript] = useState("");
  const [consent, setConsent] = useState(false);
  const [consentBy, setConsentBy] = useState("");
  const [clean, setClean] = useState<"" | "light" | "medium" | "strong">("medium");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const languages = Array.from(new Set([...(options.data?.languages ?? []), ...LANGS]));
  const audio = mode === "upload" ? file : recording;
  const canSubmit = !!audio && name.trim().length > 0 && consent && !add.isPending;

  const reset = () => {
    setFile(null);
    setRecording(null);
    setName("");
    setDescription("");
    setGender("");
    setAccent("");
    setTags("");
    setTranscript("");
    setConsent(false);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f && (f.type.startsWith("audio/") || /\.(wav|mp3|flac|ogg|opus|m4a|webm)$/i.test(f.name))) setFile(f);
  };

  const submit = () => {
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
        reset();
        onOpenChange(false);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a voice"
      description="Clone from a 7 to 14 second reference clip. The transcript is detected automatically unless you provide one."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={add.isPending}>
            Add voice
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col gap-3">
          <Segmented
            value={mode}
            onChange={setMode}
            ariaLabel="Reference source"
            options={[
              { value: "upload", label: "Upload", icon: <Upload className="size-4" /> },
              { value: "record", label: "Record", icon: <Mic className="size-4" /> },
            ]}
          />
          {mode === "upload" ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                "flex min-h-[172px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-5 text-center transition-colors",
                dragging ? "border-fire bg-fire-soft" : "border-line-strong bg-surface-2",
              )}
            >
              <input
                ref={fileInput}
                type="file"
                accept="audio/*,.wav,.mp3,.flac,.ogg,.opus,.m4a,.webm"
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <>
                  <FileAudio className="size-7 text-fire" />
                  <p className="text-[13.5px] font-medium text-ink">{file.name}</p>
                  <p className="text-[12px] text-muted">{fmtBytes(file.size)}</p>
                  <button type="button" onClick={() => setFile(null)} className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">
                    <X className="size-3.5" /> Remove
                  </button>
                </>
              ) : (
                <>
                  <Upload className="size-7 text-muted" />
                  <p className="text-[13.5px] font-medium text-ink">Drop an audio file here</p>
                  <p className="text-[12px] text-muted">wav, mp3, flac, ogg, m4a, or a browser recording</p>
                  <Button size="sm" className="mt-1" onClick={() => fileInput.current?.click()}>
                    Choose file
                  </Button>
                </>
              )}
            </div>
          ) : (
            <RecordPanel value={recording} onChange={setRecording} />
          )}

          <div>
            <Label htmlFor="av-transcript" hint="optional">
              Transcript
            </Label>
            <Textarea id="av-transcript" value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="What is said in the clip. Leave empty to auto-transcribe." className="min-h-[72px]" />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="av-name">Name</Label>
            <Input id="av-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Studio narrator" required />
          </div>
          <div>
            <Label htmlFor="av-desc" hint="optional">
              Description
            </Label>
            <Input id="av-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="warm, mid-forties, slight gravel" />
          </div>
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
          <div>
            <Label htmlFor="av-accent" hint="optional">
              Accent
            </Label>
            <Input id="av-accent" value={accent} onChange={(e) => setAccent(e.target.value)} placeholder="Lahore, Scottish, General American…" />
          </div>
          <div>
            <Label htmlFor="av-tags" hint="comma separated">
              Tags
            </Label>
            <Input id="av-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="mine, studio" />
          </div>
          <div>
            <Label htmlFor="av-clean" hint="takes out hiss, hum and room noise">Clean the clip</Label>
            <NativeSelect id="av-clean" value={clean} onChange={(e) => setClean(e.target.value as typeof clean)}>
              <option value="">No, use it as recorded</option><option value="light">Light</option><option value="medium">Medium</option><option value="strong">Strong</option>
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="av-consent-by" hint="kept in the voice's consent record">
              Who gave consent
            </Label>
            <Input id="av-consent-by" value={consentBy} onChange={(e) => setConsentBy(e.target.value)} placeholder="The speaker's name" />
          </div>
          <label className="mt-1 flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-surface-2 p-3 text-[12.5px] text-ink-2">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4 accent-[var(--fire)]" required />
            <span>
              <span className="font-medium text-ink">I own this voice or have permission to clone it.</span> Only clone voices you have the right to use.
            </span>
          </label>
        </div>
      </div>
    </Dialog>
  );
}
