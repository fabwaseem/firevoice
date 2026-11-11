import { useEffect, useState } from "react";
import { AlertTriangle, BookA, History as HistoryIcon, Keyboard, MessageSquareQuote, Mic, Settings2, Sparkles, Square, Wand2, Zap } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { HotkeyRecorder } from "@/components/dictation/HotkeyRecorder";
import { Badge, Button, Card, CardBody, CardHeader, Kbd, Segmented, Select, Switch } from "@/components/ui";
import { DictationVocabularyPanel } from "@/components/dictation/DictationVocabulary";
import { DictationSnippetsPanel } from "@/components/dictation/DictationSnippets";
import { DictationAssistantPanel } from "@/components/dictation/DictationAssistant";
import { DictationHistoryPanel } from "@/components/dictation/DictationHistory";
import { useHealth } from "@/lib/api/hooks";
import { inTauri } from "@/lib/backend";
import { dictation, hotkeyLabels } from "@/lib/dictation";
import { cn, langName } from "@/lib/utils";
import { useDictation, useDictationLive, type DictationConfig } from "@/stores/dictation";

const LANGUAGES = ["en", "ur", "hi", "ar", "es", "fr", "de", "it", "pt", "nl", "tr", "ru", "pl", "zh", "ja", "ko"];

function Row({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{title}</span>
        {description && <span className="block text-[12px] text-muted">{description}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Keys({ hotkey }: { hotkey: string }) {
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {hotkeyLabels(hotkey).map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

/** The top card: turn dictation on, start it, and see (and try) what it writes. */
function Stage() {
  const config = useDictation((s) => s.config);
  const set = useDictation((s) => s.set);
  const live = useDictationLive();
  const online = useHealth().isSuccess;
  const desktop = inTauri();
  const active = live.phase === "starting" || live.phase === "listening" || live.phase === "finishing";
  const [draft, setDraft] = useState("");

  const how =
    config.activation === "hold" ? (
      <>
        Hold <Keys hotkey={config.hotkey} /> in any app, speak, and let go.
      </>
    ) : (
      <>
        Press <Keys hotkey={config.hotkey} /> in any app, speak, and press it again to finish.
      </>
    );

  return (
    <Card raised data-tour="dictation-stage">
      <CardBody className="pt-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">Dictate anywhere</h2>
              <Badge tone={!config.enabled ? "neutral" : active ? "info" : "ok"} dot>
                {!config.enabled ? "Off" : live.phase === "listening" ? "Listening" : active ? "Working" : "Ready"}
              </Badge>
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              {config.enabled ? how : "Speak instead of typing, in any program. Your voice is turned into text on this computer; nothing is sent anywhere."}
            </p>
          </div>
          <Switch checked={config.enabled} onChange={(v) => set({ enabled: v })} label={config.enabled ? "On" : "Turn on"} disabled={!desktop} />
        </div>

        {!desktop && (
          <p className="mt-4 flex items-center gap-2 rounded-[10px] bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
            <AlertTriangle className="size-4 shrink-0" /> Dictation works in the FireVoice desktop app, not in a browser.
          </p>
        )}
        {desktop && config.enabled && live.hotkeyError && (
          <p className="mt-4 flex items-center gap-2 rounded-[10px] bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
            <AlertTriangle className="size-4 shrink-0" /> {live.hotkeyError}
          </p>
        )}
        {desktop && config.enabled && !online && (
          <p className="mt-4 flex items-center gap-2 rounded-[10px] bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
            <AlertTriangle className="size-4 shrink-0" /> FireVoice's voice engine is not running yet. Dictation starts working once it is.
          </p>
        )}
        {live.phase === "error" && live.message && (
          <p className="mt-4 flex items-center gap-2 rounded-[10px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
            <AlertTriangle className="size-4 shrink-0" /> {live.message}
          </p>
        )}

        {config.enabled && desktop && (
          <div className="mt-5 border-t border-line pt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <label htmlFor="dictation-try" className="text-[12.5px] font-medium text-ink-2">
                Try it here
              </label>
              <div className="flex items-center gap-2">
                {draft && (
                  <Button variant="ghost" size="sm" onClick={() => setDraft("")}>
                    Clear
                  </Button>
                )}
                <Button
                  variant={active ? "outline" : "primary"}
                  size="sm"
                  disabled={!online || live.phase === "finishing"}
                  leading={active ? <Square className="size-3.5" /> : <Mic className="size-3.5" />}
                  onClick={() => {
                    document.getElementById("dictation-try")?.focus();
                    dictation.toggle().catch(() => toast.error("Dictation could not start."));
                  }}
                >
                  {active ? "Stop" : "Start dictating"}
                </Button>
              </div>
            </div>
            <textarea
              id="dictation-try"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              placeholder="Click here, start dictating, and your words appear as you speak. Say “new line” for a line break."
              className={cn(
                "w-full resize-y rounded-[12px] border bg-surface-2 px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none transition-[border-color,box-shadow]",
                "placeholder:text-faint focus:border-fire focus:shadow-[0_0_0_3px_var(--fire-soft)]",
                live.phase === "listening" ? "border-fire" : "border-line-strong",
              )}
            />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function SettingsCard() {
  const config = useDictation((s) => s.config);
  const set = useDictation((s) => s.set);
  const [mics, setMics] = useState<string[]>([]);
  const desktop = inTauri();
  useEffect(() => {
    if (desktop) dictation.mics().then(setMics).catch(() => setMics([]));
  }, [desktop]);
  const off = !config.enabled;

  return (
    <Card>
      <CardHeader title="How it works" description="Choose how dictation starts and how the words arrive." />
      <CardBody className={cn("space-y-5", off && "opacity-60")}>
        <Row
          title="Start and stop"
          description={
            config.activation === "hold"
              ? "Speak while the keys are held down. Double-tap them to keep listening hands-free, and tap again to finish."
              : "One press starts, the next one stops."
          }
        >
          <Segmented<DictationConfig["activation"]>
            ariaLabel="Start and stop"
            size="sm"
            value={config.activation}
            onChange={(v) => set({ activation: v })}
            options={[
              { value: "toggle", label: "Press" },
              { value: "hold", label: "Hold" },
            ]}
          />
        </Row>
        <Row title="Hotkey" description="Works in every program while FireVoice is running.">
          <HotkeyRecorder value={config.hotkey} onChange={(hotkey) => set({ hotkey })} disabled={!desktop} />
        </Row>
        <Row
          title="Words appear"
          description={
            config.mode === "realtime"
              ? "Live, as you speak. Each word is typed once it is certain, and never changed afterwards."
              : "Polished, when you stop. The whole text is checked once more, corrections like “no wait” are applied (and the writing assistant polishes it, when it is on), then it goes in at once."
          }
        >
          <Segmented<DictationConfig["mode"]>
            ariaLabel="Words appear"
            size="sm"
            value={config.mode}
            onChange={(v) => set({ mode: v })}
            options={[
              { value: "onstop", label: "Polished", icon: <Wand2 className="size-3.5" /> },
              { value: "realtime", label: "Live", icon: <Zap className="size-3.5" /> },
            ]}
          />
        </Row>
        {config.mode === "realtime" && config.activation === "hold" && (
          <p className="rounded-[10px] bg-info-soft px-3 py-2 text-[12.5px] text-info">
            While the hotkey is held down, the words wait and are typed the moment you let go (typing while Ctrl or Alt is down would trigger
            shortcuts). To see them typed as you speak, use Press.
          </p>
        )}
        <Row title="Language" description="Automatic detects it from your first words.">
          <Select
            ariaLabel="Language"
            size="sm"
            className="w-44"
            value={config.language}
            onChange={(v) => set({ language: v })}
            options={[{ value: "auto", label: "Automatic" }, ...LANGUAGES.map((l) => ({ value: l, label: langName(l) }))]}
          />
        </Row>
        <Row title="Microphone">
          <Select
            ariaLabel="Microphone"
            size="sm"
            className="w-64"
            value={config.mic}
            onChange={(v) => set({ mic: v })}
            options={[{ value: "", label: "System default" }, ...mics.map((m) => ({ value: m, label: m }))]}
          />
        </Row>
        <Row
          title="Put the text in by"
          description={config.insert === "type" ? "Typing it, as if on the keyboard." : "Pasting it. Your clipboard is put back afterwards."}
        >
          <Segmented<DictationConfig["insert"]>
            ariaLabel="Put the text in by"
            size="sm"
            value={config.insert}
            onChange={(v) => set({ insert: v })}
            options={[
              { value: "type", label: "Typing", icon: <Keyboard className="size-3.5" /> },
              { value: "paste", label: "Pasting" },
            ]}
          />
        </Row>
        <div className="space-y-4 border-t border-line pt-5">
          <Switch
            checked={config.commands}
            onChange={(v) => set({ commands: v })}
            label="Spoken commands and punctuation"
            description="“New line”, “new paragraph”, “comma”, “full stop”, “question mark”, “open quote”… and “scratch that” or “no wait” to correct yourself."
          />
          <Switch checked={config.fillers} onChange={(v) => set({ fillers: v })} label="Leave out um and uh" />
          <Switch
            checked={config.boostQuiet}
            onChange={(v) => set({ boostQuiet: v })}
            label="Whisper mode"
            description="Brings quiet speech up to a normal level, for speaking softly in an office or at night."
          />
          <Switch checked={config.sounds} onChange={(v) => set({ sounds: v })} label="Sound when listening starts and stops" />
          <Switch
            checked={config.history}
            onChange={(v) => set({ history: v })}
            label="Keep a history of my dictations"
            description="Kept on this computer only, searchable on the History tab."
          />
          <Switch
            checked={config.keepInTray}
            onChange={(v) => set({ keepInTray: v })}
            label="Keep FireVoice running when its window is closed"
            description="It stays in the tray next to the clock, so the hotkey keeps working. Quit from the tray icon."
          />
        </div>
      </CardBody>
    </Card>
  );
}

type Tab = "setup" | "dictionary" | "snippets" | "assistant" | "history";
const TABS: { value: Tab; label: string; icon: typeof Mic }[] = [
  { value: "setup", label: "Setup", icon: Settings2 },
  { value: "dictionary", label: "Dictionary", icon: BookA },
  { value: "snippets", label: "Snippets", icon: MessageSquareQuote },
  { value: "assistant", label: "Writing assistant", icon: Sparkles },
  { value: "history", label: "History", icon: HistoryIcon },
];

export function DictationView() {
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem("dictation.tab") as Tab) || "setup");
  useEffect(() => {
    try {
      sessionStorage.setItem("dictation.tab", tab);
    } catch {
      /* private mode: the tab is simply not remembered */
    }
  }, [tab]);
  return (
    <div className="mx-auto max-w-[860px] fade-up">
      <PageHeader title="Dictation" subtitle="Speak in any program and FireVoice writes what you meant." />
      <div className="flex flex-col gap-4">
        <Stage />
        <nav role="tablist" aria-label="Dictation" className="flex gap-1 overflow-x-auto rounded-[14px] bg-surface-2 p-1">
          {TABS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[10px] px-3 text-[13px] font-medium whitespace-nowrap transition-colors",
                tab === value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
        <div role="tabpanel" key={tab} className="fade-up">
          {tab === "setup" && <SettingsCard />}
          {tab === "dictionary" && <DictationVocabularyPanel />}
          {tab === "snippets" && <DictationSnippetsPanel />}
          {tab === "assistant" && <DictationAssistantPanel />}
          {tab === "history" && <DictationHistoryPanel />}
        </div>
      </div>
    </div>
  );
}
