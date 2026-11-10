import { useEffect, useState } from "react";
import { AlertTriangle, Copy, Mic, Square, Trash2, Zap, Clock, Keyboard, Type } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell/PageHeader";
import { HotkeyRecorder } from "@/components/dictation/HotkeyRecorder";
import { Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, EmptyState, Kbd, Segmented, Select, Switch, Tooltip } from "@/components/ui";
import { useHealth } from "@/lib/api/hooks";
import { inTauri } from "@/lib/backend";
import { dictation, hotkeyLabels } from "@/lib/dictation";
import { cn, langName, relTime } from "@/lib/utils";
import { countWords, useDictation, useDictationLive, type DictationConfig } from "@/stores/dictation";

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
    <Card raised>
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

function Stats() {
  const words = useDictation((s) => s.words);
  const seconds = useDictation((s) => s.seconds);
  const wpm = seconds > 5 ? Math.round(words / (seconds / 60)) : null;
  // typing the same words at an average 40 words a minute
  const saved = Math.max(0, words / 40 - seconds / 60);
  const items = [
    { icon: Type, label: "Words dictated", value: words.toLocaleString() },
    { icon: Zap, label: "Speaking speed", value: wpm ? `${wpm} words a minute` : "–" },
    { icon: Clock, label: "Time saved over typing", value: saved >= 1 ? `${Math.round(saved)} min` : "–" },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {items.map(({ icon: Icon, label, value }) => (
        <Card key={label} className="flex items-center gap-3 px-4 py-3.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-fire-soft text-fire">
            <Icon className="size-[17px]" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold text-ink tabular">{value}</div>
            <div className="truncate text-[12px] text-muted">{label}</div>
          </div>
        </Card>
      ))}
    </div>
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
        <Row title="Start and stop" description={config.activation === "hold" ? "Speak while the keys are held down." : "One press starts, the next one stops."}>
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
              ? "As you speak. Each word is typed once it is certain, and never changed afterwards."
              : "When you stop. The whole text is checked once more and inserted in one go."
          }
        >
          <Segmented<DictationConfig["mode"]>
            ariaLabel="Words appear"
            size="sm"
            value={config.mode}
            onChange={(v) => set({ mode: v })}
            options={[
              { value: "realtime", label: "As you speak", icon: <Zap className="size-3.5" /> },
              { value: "onstop", label: "When you stop" },
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
            label="Spoken line breaks"
            description="Say “new line” or “new paragraph” to start one."
          />
          <Switch checked={config.fillers} onChange={(v) => set({ fillers: v })} label="Leave out um and uh" />
          <Switch checked={config.sounds} onChange={(v) => set({ sounds: v })} label="Sound when listening starts and stops" />
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

function History() {
  const history = useDictation((s) => s.history);
  const remove = useDictation((s) => s.remove);
  const clear = useDictation((s) => s.clear);
  const [confirm, setConfirm] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  };
  return (
    <Card>
      <CardHeader
        title="Recent dictations"
        description="Kept on this computer only."
        action={
          history.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>
              Clear all
            </Button>
          )
        }
      />
      <CardBody>
        {history.length === 0 ? (
          <EmptyState icon={<Mic />} title="Nothing dictated yet" description="What you dictate shows up here, ready to copy again." />
        ) : (
          <ul className="divide-y divide-line">
            {history.map((h) => (
              <li key={h.id} className="group flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">{h.text}</p>
                  <p className="mt-1 text-[11.5px] text-faint">
                    {relTime(h.at / 1000)} · {countWords(h.text)} words{h.language ? ` · ${langName(h.language)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <Tooltip content="Copy">
                    <button
                      type="button"
                      aria-label="Copy this dictation"
                      onClick={() => copy(h.text)}
                      className="flex size-8 items-center justify-center rounded-[9px] text-muted hover:bg-surface-3/70 hover:text-ink"
                    >
                      <Copy className="size-4" />
                    </button>
                  </Tooltip>
                  <Tooltip content="Remove">
                    <button
                      type="button"
                      aria-label="Remove this dictation"
                      onClick={() => remove(h.id)}
                      className="flex size-8 items-center justify-center rounded-[9px] text-muted hover:bg-bad-soft hover:text-bad"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </Tooltip>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Clear all recent dictations?"
        description="The list is emptied. Text already typed into other programs stays where it is."
        confirmLabel="Clear all"
        onConfirm={() => {
          clear();
          setConfirm(false);
        }}
      />
    </Card>
  );
}

export function DictationView() {
  return (
    <div className="mx-auto max-w-[820px] fade-up">
      <PageHeader title="Dictation" subtitle="Speak in any program and FireVoice types what you say." />
      <div className="flex flex-col gap-4">
        <Stage />
        <Stats />
        <SettingsCard />
        <History />
      </div>
    </div>
  );
}
