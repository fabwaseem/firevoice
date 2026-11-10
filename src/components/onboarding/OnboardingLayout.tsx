import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { AudioLines, Check, Languages, Library, MessagesSquare, Mic, Music, ShieldCheck, Wand2 } from "lucide-react";
import { Logo } from "@/components/shell/Logo";
import { cn } from "@/lib/utils";

type Icon = ComponentType<{ className?: string }>;

/** What FireVoice does, in plain words: the welcome grid and the rotating spotlight both read from here. */
export const FEATURES: { icon: Icon; title: string; text: string }[] = [
  { icon: AudioLines, title: "Speak", text: "Type a script, pick a voice and a delivery, and hear it in seconds." },
  { icon: Library, title: "100 voices", text: "Narrators, characters and accents, ready to use from the first minute." },
  { icon: Wand2, title: "Your own voices", text: "Copy a voice from a short clip, or describe one and FireVoice creates it." },
  { icon: MessagesSquare, title: "Dialogue", text: "Write a conversation; every speaker keeps their own voice." },
  { icon: Languages, title: "Dubbing", text: "Turn a video or recording into another language, music kept." },
  { icon: Mic, title: "Transcribe", text: "Speech to text with word timings and who said what." },
  { icon: Music, title: "Sound and music", text: "Sound effects, ambience and music tracks from a description." },
  { icon: ShieldCheck, title: "Private", text: "Everything runs on this computer. Nothing you write is uploaded." },
];

/** A row of softly moving bars: the FireVoice waveform as a living mark. */
export function Waveform({ bars = 28, className }: { bars?: number; className?: string }) {
  return (
    <div className={cn("flex h-16 items-center gap-[5px]", className)} aria-hidden>
      {Array.from({ length: bars }).map((_, i) => {
        const h = 22 + 70 * Math.abs(Math.sin(i * 0.55)) * (0.55 + 0.45 * Math.cos(i * 0.21));
        return <span key={i} className="onb-bar w-[4px] rounded-full fire-gradient" style={{ height: `${h}%`, animationDelay: `${(i % 9) * 110}ms` }} />;
      })}
    </div>
  );
}

/** One feature at a time, changing every few seconds, with dots to jump between them. */
export function Spotlight({ label = "Inside FireVoice" }: { label?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % FEATURES.length), 5200);
    return () => clearInterval(t);
  }, [i]);
  const f = FEATURES[i];
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 backdrop-blur-sm">
      <div className="mb-3 text-[11px] font-semibold tracking-[0.12em] text-white/45 uppercase">{label}</div>
      <div key={i} className="onb-in flex items-start gap-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl fire-gradient text-white shadow-[0_8px_24px_-10px_rgba(255,106,61,0.9)]">
          <f.icon className="size-5" />
        </span>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-white">{f.title}</div>
          <p className="mt-0.5 text-[13px] leading-relaxed text-white/65">{f.text}</p>
        </div>
      </div>
      <div className="mt-4 flex gap-1.5">
        {FEATURES.map((_, n) => (
          <button
            key={n}
            type="button"
            aria-label={`Show ${FEATURES[n].title}`}
            onClick={() => setI(n)}
            className={cn("h-1.5 rounded-full transition-all duration-300", n === i ? "w-6 bg-white/80" : "w-1.5 bg-white/25 hover:bg-white/45")}
          />
        ))}
      </div>
    </div>
  );
}

export interface StepInfo {
  id: string;
  title: string;
  hint: string;
}

/** The brand panel on the left of every step after the welcome: where you are, and what FireVoice can do. */
function BrandPanel({ steps, current, spotlightLabel }: { steps: StepInfo[]; current: string; spotlightLabel?: string }) {
  const at = steps.findIndex((s) => s.id === current);
  return (
    <aside className="onb-brand relative hidden w-[400px] shrink-0 flex-col justify-between overflow-hidden p-9 text-white lg:flex">
      <div className="relative">
        <div className="flex items-center gap-3">
          <Logo size={36} />
          <span className="text-[17px] font-semibold tracking-[-0.01em]">FireVoice</span>
        </div>
        <ol className="mt-12 space-y-1">
          {steps.map((s, n) => {
            const done = n < at;
            const on = n === at;
            return (
              <li key={s.id} className={cn("flex items-start gap-3.5 rounded-xl px-3 py-2.5 transition-colors", on && "bg-white/[0.06]")}>
                <span
                  className={cn(
                    "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular transition-colors",
                    done ? "bg-white text-[#16171c]" : on ? "fire-gradient text-white" : "border border-white/20 text-white/50",
                  )}
                >
                  {done ? <Check className="size-3.5" strokeWidth={3} /> : n + 1}
                </span>
                <span className="min-w-0">
                  <span className={cn("block text-[14px] font-medium", on || done ? "text-white" : "text-white/55")}>{s.title}</span>
                  <span className={cn("block text-[12.5px]", on ? "text-white/60" : "text-white/35")}>{s.hint}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="relative space-y-6">
        <Waveform className="opacity-80" />
        <Spotlight label={spotlightLabel} />
      </div>
    </aside>
  );
}

/** Every step after the welcome: brand panel on the left, the step itself on the right. */
export function SplitLayout({ steps, current, spotlightLabel, children }: { steps: StepInfo[]; current: string; spotlightLabel?: string; children: ReactNode }) {
  return (
    <div className="flex h-full w-full bg-bg">
      <BrandPanel steps={steps} current={current} spotlightLabel={spotlightLabel} />
      <main className="relative flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-8 py-10">
        <div key={current} className="onb-in w-full max-w-[580px]">
          {children}
        </div>
      </main>
    </div>
  );
}

/** A step's heading: a small label, the title and one line of explanation. */
export function StepHeader({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-7">
      <div className="mb-2 text-[12px] font-semibold tracking-[0.12em] text-fire uppercase">{eyebrow}</div>
      <h1 className="text-[30px] leading-[1.15] font-semibold tracking-[-0.025em] text-ink">{title}</h1>
      {children && <p className="mt-2.5 text-[14.5px] leading-relaxed text-muted">{children}</p>}
    </header>
  );
}
