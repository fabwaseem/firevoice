import { ArrowRight, BookA, Hand, History, Languages, MessageSquareQuote, Sparkles, Undo2, Wand2, X } from "lucide-react";
import { Card } from "@/components/ui";
import { hotkeyLabels } from "@/lib/dictation";
import { FEATURES_VERSION, useDictation } from "@/stores/dictation";

export type DictationTab = "setup" | "dictionary" | "snippets" | "assistant" | "history";

const FEATURES: { icon: typeof Sparkles; title: string; text: (keys: string) => string; tab: DictationTab; cta: string }[] = [
  {
    icon: Sparkles,
    title: "Writes what you meant",
    text: () => "The writing assistant fixes grammar and punctuation, drops false starts and lays out lists, in the style of the app you are in.",
    tab: "assistant",
    cta: "Writing assistant",
  },
  {
    icon: Wand2,
    title: "Edit by voice",
    text: (keys) => `Select text anywhere, press ${keys} and say “make it shorter” or “translate to Spanish”.`,
    tab: "assistant",
    cta: "Command mode",
  },
  {
    icon: Languages,
    title: "Speak one language, write another",
    text: () => "Turn on Translate and speak Urdu, Spanish or any language: it is written in the one you choose.",
    tab: "setup",
    cta: "Set it up",
  },
  {
    icon: Undo2,
    title: "Correct yourself out loud",
    text: () => "Say “no wait” or “scratch that” and only the correction goes in. Say “comma”, “new line”, “question mark”.",
    tab: "setup",
    cta: "Spoken commands",
  },
  {
    icon: BookA,
    title: "Your names, spelled right",
    text: () => "Add the names and terms you use, and fix words FireVoice keeps getting wrong. One dictionary, for dictation and the voices.",
    tab: "dictionary",
    cta: "Dictionary",
  },
  {
    icon: MessageSquareQuote,
    title: "Snippets",
    text: () => "Say “my email” or “sign off” and the full text is typed for you.",
    tab: "snippets",
    cta: "Add a snippet",
  },
  {
    icon: Hand,
    title: "Hands-free and whisper mode",
    text: () => "Double-tap the keys to keep listening without holding them. Whisper mode hears you when you speak softly.",
    tab: "setup",
    cta: "Setup",
  },
  {
    icon: History,
    title: "Every dictation, searchable",
    text: () => "Find anything you dictated, copy it again, and teach FireVoice a word from it.",
    tab: "history",
    cta: "Your dictations",
  },
];

/** The new dictation features, once, at the top of the page: each one a step away. */
export function DictationWhatsNew({ open }: { open: (tab: DictationTab) => void }) {
  const seen = useDictation((s) => s.config.featuresSeen);
  const commandHotkey = useDictation((s) => s.config.commandHotkey);
  const set = useDictation((s) => s.set);
  if (seen >= FEATURES_VERSION) return null;
  const keys = hotkeyLabels(commandHotkey || "Ctrl+Alt+Shift+Space").join(" + ");
  const close = () => set({ featuresSeen: FEATURES_VERSION });

  return (
    <Card raised className="relative overflow-hidden rounded-2xl p-5">
      <div className="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-fire/10 blur-3xl" aria-hidden />
      <div className="relative flex items-start justify-between gap-4">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full fire-gradient px-2 py-0.5 text-[10.5px] font-semibold tracking-wide text-white uppercase">
            New
          </span>
          <h2 className="mt-2 text-[17px] font-semibold tracking-[-0.01em] text-ink">Dictation does a lot more now</h2>
          <p className="mt-0.5 text-[13px] text-muted">Everything runs on this computer. Pick one to try:</p>
        </div>
        <button type="button" aria-label="Close" onClick={close} className="grid size-8 shrink-0 place-items-center rounded-full text-faint hover:bg-surface-3 hover:text-ink">
          <X className="size-4" />
        </button>
      </div>
      <div className="relative mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FEATURES.map(({ icon: Icon, title, text, tab, cta }) => (
          <button
            key={title}
            type="button"
            onClick={() => open(tab)}
            className="group flex items-start gap-3 rounded-[12px] bg-surface-2 px-3.5 py-3 text-left transition-colors hover:bg-surface-3"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-fire-soft text-fire">
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-ink">{title}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-muted">{text(keys)}</span>
              <span className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-fire">
                {cta} <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
              </span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}
