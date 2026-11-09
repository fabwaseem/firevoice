import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Play, Shuffle } from "lucide-react";
import { api } from "@/lib/api/client";
import { errMessage } from "@/lib/api/hooks";
import type { DesignBatch } from "@/lib/api/types";
import { Link } from "react-router";
import { Sparkles } from "lucide-react";
import { useDesignVoice, useEngines } from "@/lib/api/hooks";
import { langName } from "@/lib/utils";
import { Button, Chip, Dialog, Input, Label, Select, Textarea } from "@/components/ui";
import { DESIGN_EXAMPLES, GENDERS } from "./helpers";

const LANGS = ["en", "ur", "hi", "ar", "zh", "ja", "ko", "de", "fr", "es", "it", "pt", "ru", "tr"];

export function DesignVoiceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const engines = useEngines();
  const design = useDesignVoice();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [engine, setEngine] = useState<string>("");
  const [gender, setGender] = useState("");
  const [language, setLanguage] = useState("en");
  const [text, setText] = useState("");
  const [batch, setBatch] = useState<DesignBatch | null>(null);
  const [trying, setTrying] = useState(false);
  const [keeping, setKeeping] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const qc = useQueryClient();

  const tryVersions = async () => {
    setTrying(true);
    try {
      setBatch(await api.designCandidates({ description: description.trim(), n: 3, engine: engineValue || undefined, text: text.trim() || undefined }));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setTrying(false);
    }
  };
  const keep = async (n: number) => {
    if (!batch) return;
    if (!name.trim()) {
      toast.error("Give the voice a name first");
      return;
    }
    setKeeping(n);
    try {
      const v = await api.keepDesignCandidate(batch.batch, n, { name: name.trim(), gender: gender || undefined, language: language || undefined });
      toast.success(`Kept “${v.name || v.voice_id}”`);
      qc.invalidateQueries({ queryKey: ["voices"] });
      setBatch(null);
      setName("");
      setDescription("");
      onOpenChange(false);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setKeeping(null);
    }
  };

  const designEngines = useMemo(() => (engines.data ?? []).filter((e) => e.design && e.ready), [engines.data]);
  const engineValue = engine || designEngines[0]?.name || "";
  const canSubmit = name.trim().length > 0 && description.trim().length > 12 && !!engineValue && !design.isPending;

  const submit = () => {
    design.mutate(
      {
        name: name.trim(),
        description: description.trim(),
        engine: engineValue,
        gender: gender || undefined,
        language: language || undefined,
        text: text.trim() || undefined,
      },
      {
        onSuccess: () => {
          setName("");
          setDescription("");
          setText("");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Design a voice"
      description="Describe the voice you want. FireVoice renders a reference take in the background and locks it so every engine can clone it."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={tryVersions} disabled={description.trim().length <= 12 || !engineValue || trying} loading={trying} leading={<Shuffle className="size-4" />}>
            Try 3 versions
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={design.isPending} leading={<Sparkles className="size-4" />}>
            Design voice
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {batch && (
          <div className="rounded-xl border border-line bg-surface-2 p-3">
            <p className="mb-2 text-[13px] font-medium text-ink">Pick the version you like</p>
            {batch.candidates.map((c) => (
              <div key={c.n} className="flex items-center gap-2 py-1">
                <Button size="icon-sm" variant="ghost" aria-label={`Play version ${c.n}`}
                  onClick={() => { audioRef.current?.pause(); audioRef.current = new Audio(api.designCandidateUrl(batch.batch, c.n)); void audioRef.current.play(); }}>
                  <Play className="size-4" />
                </Button>
                <span className="text-[13px] text-ink">Version {c.n}</span>
                <span className="text-[12px] text-muted">{c.duration}s</span>
                <div className="flex-1" />
                <Button size="sm" variant="primary" onClick={() => void keep(c.n)} loading={keeping === c.n}>Keep this one</Button>
              </div>
            ))}
          </div>
        )}
        <div>
          <Label htmlFor="dv-name">Name</Label>
          <Input id="dv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ghost narrator" />
        </div>
        <div>
          <Label htmlFor="dv-desc" hint={`${description.length} chars`}>
            Description
          </Label>
          <Textarea
            id="dv-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Age, tone, texture, energy, accent, and where you would hear this voice…"
            className="min-h-[96px]"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {DESIGN_EXAMPLES.map((ex) => (
              <Chip key={ex} onClick={() => setDescription(ex)} className="h-7 max-w-full text-[12px]">
                <span className="truncate">{ex.split(" ").slice(0, 6).join(" ")}…</span>
              </Chip>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Engine</Label>
            {designEngines.length ? (
              <Select
                value={engineValue}
                onChange={setEngine}
                options={designEngines.map((e) => ({ value: e.name, label: e.title, description: e.name }))}
                ariaLabel="Design engine"
              />
            ) : (
              <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
                No design-capable engine is installed. See <Link to="/engines" className="text-fire hover:underline">Engines</Link>.
              </p>
            )}
          </div>
          <div>
            <Label>Gender</Label>
            <Select value={gender} onChange={setGender} options={GENDERS} ariaLabel="Gender" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Language</Label>
            <Select value={language} onChange={setLanguage} options={LANGS.map((l) => ({ value: l, label: langName(l) }))} ariaLabel="Language" />
          </div>
        </div>

        <div>
          <Label htmlFor="dv-text" hint="optional">
            Sample text
          </Label>
          <Textarea id="dv-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Leave empty to use the built-in reference paragraph." className="min-h-[64px]" />
        </div>

        <p className="text-[12px] text-muted">
          Design runs as a background job. Follow it in <Link to="/jobs" className="text-fire hover:underline">Jobs</Link>; the voice appears here when it finishes.
        </p>
      </div>
    </Dialog>
  );
}
