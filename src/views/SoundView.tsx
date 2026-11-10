import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Dices, Music, PenLine, Sparkles, Timer, Waves } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { errMessage, useEngines } from "@/lib/api/hooks";
import { usePlayer } from "@/stores/player";
import { PageHeader } from "@/components/shell/PageHeader";
import { RecentHistory } from "@/components/history/HistoryList";
import { Badge, Button, Card, Label, Segmented } from "@/components/ui";
import { useSessionState } from "@/stores/session";

type Kind = "sfx" | "music";

const IDEAS: Record<Kind, string[]> = {
  sfx: ["ocean waves crashing on a beach", "a wooden door creaking open slowly", "a campfire crackling at night, crickets", "a thunderstorm with heavy rain", "footsteps on a stone floor"],
  music: ["calm lo-fi piano bed for a podcast intro, warm and slow", "upbeat acoustic guitar, bright, for a product video", "tense cinematic strings, low and slow", "soft ambient pads for meditation"],
};

/** Sound effects, ambience and music from a description (Crackle, Bonfire). Everything made is kept in History. */
export function SoundView() {
  const engines = useEngines("sfx");
  const [kind, setKind] = useSessionState<Kind>("sound.kind", "sfx");
  const [prompt, setPrompt] = useSessionState("sound.prompt", IDEAS.sfx[0]);
  const [seconds, setSeconds] = useSessionState("sound.seconds", 5);
  const [seed, setSeed] = useSessionState("sound.seed", "");
  const [busy, setBusy] = useSessionState("sound.busy", false);
  const qc = useQueryClient();
  const load = usePlayer((s) => s.load);
  const engineName = kind === "music" ? "musicgen" : "audioldm2";
  const engine = engines.data?.find((e) => e.name === engineName);

  const make = async () => {
    if (!prompt.trim()) return toast.error("Describe the sound first");
    setBusy(true);
    try {
      const r = await api.sound({ prompt: prompt.trim(), kind, duration: seconds, seed: seed ? Number(seed) : undefined });
      // play it from History, where it is kept (the response itself is only needed when nothing was saved)
      const src = r.historyId ? api.historyAudioUrl({ id: r.historyId }) : URL.createObjectURL(r.blob);
      load({ id: r.historyId ? `history:${r.historyId}:audio` : `sound-${Date.now()}`, title: prompt.trim(), subtitle: kind === "music" ? "Music" : "Sound effect", src, href: "/sound" });
      void qc.invalidateQueries({ queryKey: ["history"] });
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
              {engine.title}{engine.tagline ? ` · ${engine.tagline}` : ""}
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
          <Label htmlFor="snd-prompt" icon={<PenLine />}>Describe it</Label>
          <textarea
            id="snd-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && make()}
            rows={3}
            placeholder={IDEAS[kind][0]}
            className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[14px] text-ink outline-none focus:border-fire"
          />
          {kind === "sfx" && <p className="mt-1.5 text-[12px] text-faint">One sound per description works best; make the others separately.</p>}
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
            <Label htmlFor="snd-len" hint={seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")} min` : `${seconds}s`} icon={<Timer />}>Length</Label>
            <input id="snd-len" type="range" min={1} max={kind === "music" ? 180 : 30} step={kind === "music" ? 1 : 0.5} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className="w-full accent-[var(--fire)]" />
          </div>
          <div>
            <Label htmlFor="snd-seed" hint="empty = new" icon={<Dices />}>Seed</Label>
            <input id="snd-seed" value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ""))} className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-[13px] text-ink outline-none focus:border-fire" />
          </div>
          <Button leading={<Sparkles className="size-4" />} loading={busy} disabled={!engine?.ready} onClick={make}>
            Make it
          </Button>
        </div>
      </Card>

      <RecentHistory kinds={["sound", "music"]} title="Made here" empty="Sounds and music you make are saved automatically and listed here." />
    </div>
  );
}
