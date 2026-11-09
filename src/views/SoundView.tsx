import { useState } from "react";
import { Link } from "react-router";
import { Dice5, Download, Music, Play, Sparkles, Waves } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { errMessage, useEngines } from "@/lib/api/hooks";
import { saveBlob } from "@/lib/audio";
import { PageHeader } from "@/components/shell/PageHeader";
import { Badge, Button, Card, Label, Segmented } from "@/components/ui";

type Kind = "sfx" | "music";
interface Made {
  id: string;
  prompt: string;
  kind: Kind;
  url: string;
  blob: Blob;
  seed: string;
  duration: string;
  engine: string;
}

const IDEAS: Record<Kind, string[]> = {
  sfx: ["a wooden door creaks open slowly, footsteps on a stone floor", "rain on a tin roof, distant thunder", "a busy cafe, cups clinking, soft chatter", "a crowd cheers in a stadium"],
  music: ["calm lo-fi piano bed for a podcast intro, warm and slow", "upbeat acoustic guitar, bright, for a product video", "tense cinematic strings, low and slow", "soft ambient pads for meditation"],
};

/** Sound effects, ambience and music beds from a description (AudioLDM 2, MusicGen). */
export function SoundView() {
  const engines = useEngines("sfx");
  const [kind, setKind] = useState<Kind>("sfx");
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState(5);
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Made[]>([]);
  const engineName = kind === "music" ? "musicgen" : "audioldm2";
  const engine = engines.data?.find((e) => e.name === engineName);

  const make = async () => {
    if (!prompt.trim()) return toast.error("Describe the sound first");
    setBusy(true);
    try {
      const r = await api.sound({ prompt: prompt.trim(), kind, duration: seconds, seed: seed ? Number(seed) : undefined });
      setMade((m) => [{ id: `${Date.now()}`, prompt: prompt.trim(), kind, url: URL.createObjectURL(r.blob), blob: r.blob, seed: r.seed, duration: r.duration, engine: r.engine }, ...m]);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1000px] fade-up">
      <PageHeader title="Sound" subtitle="Sound effects, ambience and music beds from a description, made on this machine." />
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<Kind>
            value={kind}
            onChange={(k) => {
              setKind(k);
              setSeconds(k === "music" ? 8 : 5);
            }}
            options={[
              { value: "sfx", label: "Sound effect", icon: <Waves className="size-4" /> },
              { value: "music", label: "Music bed", icon: <Music className="size-4" /> },
            ]}
          />
          {engine && (
            <Badge tone={engine.ready ? "neutral" : "warn"}>
              {engine.title} · {engine.license}
            </Badge>
          )}
        </div>
        {engines.isSuccess && !engine && (
          <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
            This backend has no sound engines yet (it is older than the app). Restart or update the backend, then reload this page.
          </p>
        )}
        {engine && !engine.ready && (
          <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-muted">
            {engine.title} is not installed yet. Install it from <Link to="/engines" className="font-medium text-fire hover:underline">Engines</Link> (about 3 GB with its model).
          </p>
        )}
        <div className="mt-4">
          <Label htmlFor="snd-prompt">Describe it</Label>
          <textarea
            id="snd-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && make()}
            rows={3}
            placeholder={IDEAS[kind][0]}
            className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[14px] text-ink outline-none focus:border-fire"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {IDEAS[kind].map((t) => (
              <button key={t} type="button" onClick={() => setPrompt(t)} className="rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-muted hover:text-ink">
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_160px_auto] sm:items-end">
          <div>
            <Label htmlFor="snd-len" hint={`${seconds}s`}>Length</Label>
            <input id="snd-len" type="range" min={1} max={30} step={0.5} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className="w-full accent-[var(--fire)]" />
          </div>
          <div>
            <Label htmlFor="snd-seed" hint="empty = new">Seed</Label>
            <input id="snd-seed" value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ""))} className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-fire" />
          </div>
          <Button leading={<Sparkles className="size-4" />} loading={busy} disabled={!engine?.ready} onClick={make}>
            Make it
          </Button>
        </div>
        <p className="mt-3 text-[12px] text-faint">Both models' weights are licensed for non-commercial use only. Everything made here carries FireVoice's inaudible watermark.</p>
      </Card>

      {made.length > 0 && (
        <div className="mt-4 space-y-2">
          {made.map((m) => (
            <Card key={m.id} className="flex flex-col gap-2 p-4 md:flex-row md:items-center">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] text-ink">{m.prompt}</p>
                <p className="text-[12px] text-faint">
                  {m.kind === "music" ? "music" : "effect"} · {m.duration}s · seed {m.seed}
                </p>
              </div>
              <audio controls src={m.url} className="h-9 md:w-[320px]" />
              <div className="flex gap-1">
                <Button size="icon-sm" variant="ghost" aria-label="Make again with this seed" onClick={() => { setPrompt(m.prompt); setKind(m.kind); setSeed(m.seed); }}>
                  <Dice5 className="size-4" />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Download" onClick={() => void saveBlob(m.blob, `${m.prompt.slice(0, 40).replace(/[^a-z0-9]+/gi, "-")}.mp3`)}>
                  <Download className="size-4" />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Play" onClick={() => void new Audio(m.url).play()}>
                  <Play className="size-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
