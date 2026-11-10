import { type ComponentType, type ReactNode } from "react";
import { AudioLines, Check, Languages, Library, MessagesSquare, Mic, Music, ShieldCheck, Wand2 } from "lucide-react";
import { Logo } from "@/components/shell/Logo";
import { cn } from "@/lib/utils";

type Icon = ComponentType<{ className?: string }>;

/** What FireVoice does, in plain words (the welcome grid). */
export const FEATURES: { icon: Icon; title: string; text: string }[] = [
  { icon: AudioLines, title: "Speak", text: "Type a script, pick a voice and a delivery, and hear it in seconds." },
  { icon: Library, title: "100 voices", text: "Narrators, characters and accents, ready to use from the first minute." },
  { icon: Wand2, title: "Your own voices", text: "Copy a voice from a short clip, or describe one and FireVoice creates it." },
  { icon: Mic, title: "Dictation", text: "Speak in any program and FireVoice types what you say." },
  { icon: MessagesSquare, title: "Dialogue", text: "Write a conversation; every speaker keeps their own voice." },
  { icon: Languages, title: "Dubbing", text: "Turn a video or recording into another language, music kept." },
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

export interface StepInfo {
  id: string;
  title: string;
}

/** Where you are in the first run: numbered dots joined by a line, the current one lit, done ones ticked. */
export function Stepper({ steps, current }: { steps: StepInfo[]; current: string }) {
  const at = steps.findIndex((s) => s.id === current);
  return (
    <ol className="flex items-center" aria-label="Setup steps">
      {steps.map((s, n) => {
        const done = n < at;
        const on = n === at;
        return (
          <li key={s.id} className="flex items-center" aria-current={on ? "step" : undefined}>
            {n > 0 && <span className={cn("mx-2 h-px w-6 transition-colors md:w-10", n <= at ? "bg-fire/60" : "bg-line-strong")} aria-hidden />}
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold tabular transition-colors",
                  done ? "bg-fire text-white" : on ? "fire-gradient text-white shadow-[0_0_0_4px_var(--fire-soft)]" : "border border-line-strong text-faint",
                )}
              >
                {done ? <Check className="size-3.5" strokeWidth={3} /> : n + 1}
              </span>
              <span className={cn("text-[12.5px] font-medium whitespace-nowrap", on ? "text-ink" : done ? "text-ink-2" : "text-faint", !on && "hidden lg:inline")}>
                {s.title}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Every screen of the first run: a slim top bar (logo, the steps, and actions on the right) over centred content. */
export function OnboardingFrame({
  steps,
  current,
  actions,
  wide,
  children,
}: {
  steps?: StepInfo[];
  current?: string;
  actions?: ReactNode;
  /** the welcome screen uses the full width */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="onb-hero flex h-full w-full flex-col">
      <header className="flex h-16 shrink-0 items-center gap-4 px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Logo size={28} />
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">FireVoice</span>
        </div>
        {steps && current && <Stepper steps={steps} current={current} />}
        <div className="flex flex-1 items-center justify-end gap-2">{actions}</div>
      </header>
      <main className="flex min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        <div key={current ?? "frame"} className={cn("onb-in m-auto w-full py-6", wide ? "max-w-[980px]" : "max-w-[620px]")}>
          {children}
        </div>
      </main>
    </div>
  );
}

/** A step's heading, centred: a small label, the title and one line of explanation. */
export function StepHeader({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-8 text-center">
      <div className="mb-2 text-[12px] font-semibold tracking-[0.12em] text-fire uppercase">{eyebrow}</div>
      <h1 className="text-[30px] leading-[1.15] font-semibold tracking-[-0.025em] text-ink">{title}</h1>
      {children && <p className="mx-auto mt-2.5 max-w-[520px] text-[14.5px] leading-relaxed text-muted">{children}</p>}
    </header>
  );
}
