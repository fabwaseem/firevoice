import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Mic } from "@/components/icons";
import { onDictation, hotkeyLabels, type DictationStateEvent, type DictationTextEvent } from "@/lib/dictation";
import { DEFAULT_DICTATION, type DictationConfig, type DictationPhase } from "@/stores/dictation";

const BARS = 26;

/** The dictation settings as the main window last saved them (both windows share the same storage). */
function savedConfig(): DictationConfig {
  try {
    const raw = JSON.parse(localStorage.getItem("firevoice.dictation") ?? "{}");
    return { ...DEFAULT_DICTATION, ...(raw?.state?.config ?? {}) };
  } catch {
    return DEFAULT_DICTATION;
  }
}

let audio: AudioContext | null = null;
/** A short soft tone: rising when listening starts, falling when it stops. */
function chime(up: boolean) {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(up ? 520 : 700, t);
    o.frequency.exponentialRampToValueAtTime(up ? 780 : 470, t + 0.11);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.18);
  } catch {
    /* no sound device: the overlay still shows what is happening */
  }
}

/** Tips for the first dictations, shown while listening before any words appear: one per dictation, in turn, and only
 * the ones that fit the settings. The count lives in its own key (the main window owns the settings' storage). */
const TIP_KEY = "firevoice.dictation.tips";
const TIP_DICTATIONS = 30;

function tipsFor(cfg: DictationConfig): string[] {
  const out: string[] = [];
  if (cfg.commands) {
    out.push("Tip: say “no wait” or “scratch that” to correct yourself");
    out.push("Tip: say “comma”, “question mark” or “new line”");
  }
  if (cfg.commandHotkey) out.push(`Tip: select text and press ${hotkeyLabels(cfg.commandHotkey).join(" + ")} to edit it by voice`);
  if (cfg.activation === "hold") out.push("Tip: double-tap the keys to keep listening hands-free");
  if (cfg.translateTo) out.push("Tip: speak in any language, it is written in your chosen one");
  else out.push("Tip: Translate in Dictation settings writes what you say in another language");
  out.push("Tip: snippets type a whole text from a short phrase (Dictation, Snippets)");
  out.push("Tip: add names FireVoice gets wrong in Dictation, Dictionary");
  return out;
}

/** The tip for the dictation that is starting, or null once enough dictations have shown one. */
function nextTip(cfg: DictationConfig): string | null {
  // the first dictation has the guide around the pill instead, which says what to do
  if (!cfg.spotlightDone) return null;
  try {
    const n = Number(localStorage.getItem(TIP_KEY) ?? "0") || 0;
    if (n >= TIP_DICTATIONS) return null;
    localStorage.setItem(TIP_KEY, String(n + 1));
    const tips = tipsFor(cfg);
    return tips[n % tips.length] ?? null;
  } catch {
    return null;
  }
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The small window that floats over other programs while dictating: the voice's level, the words as they form,
 * and what is happening (getting ready, listening, finishing, done, or what went wrong). */
export function Overlay() {
  const [phase, setPhase] = useState<DictationPhase | "done">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [tentative, setTentative] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [config, setConfig] = useState(savedConfig);
  const [tip, setTip] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const bars = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const levels = useRef<number[]>(Array(BARS).fill(0));
  const phaseRef = useRef(phase);
  // the dictation that is ending put text in (the shell sends the result just before it goes idle)
  const inserted = useRef(false);
  phaseRef.current = phase;

  useEffect(() => {
    const subs = [
      onDictation<DictationStateEvent>("dictation", (e) => {
        const cfg = savedConfig();
        const was = phaseRef.current;
        if (e.state === "starting") {
          inserted.current = false;
          setConfig(cfg);
          setTip(nextTip(cfg));
          setText("");
          setTentative("");
          setSeconds(0);
          levels.current.fill(0);
        }
        if (cfg.sounds && e.state === "listening") chime(true);
        if (cfg.sounds && e.state === "finishing") chime(false);
        setMessage(e.message);
        // a dictation that put text in becomes a green tick for a moment before the window goes; one that put
        // nothing in just fades
        if (e.state === "idle" && was === "finishing" && !inserted.current) {
          setLeaving(true);
          return;
        }
        setLeaving(false);
        setPhase(e.state === "idle" && was === "finishing" ? "done" : e.state);
      }),
      onDictation<{ text: string }>("dictation-result", (e) => {
        inserted.current = !!e.text?.trim();
      }),
      onDictation<DictationTextEvent>("dictation-text", (e) => {
        setText(e.text);
        setTentative(e.tentative);
      }),
      onDictation<number>("dictation-level", (rms) => {
        // loudness as the ear hears it, newest on the right
        const v = Math.min(1, Math.sqrt(rms * 14));
        const l = levels.current;
        l.push(v);
        l.shift();
      }),
    ];
    return () => {
      for (const s of subs) s.then((off) => off()).catch(() => {});
    };
  }, []);

  // the bars follow the level without re-rendering: one frame, one style write per bar
  useEffect(() => {
    if (phase !== "listening") return;
    let raf = 0;
    const shown = Array(BARS).fill(0.12);
    const draw = () => {
      const el = bars.current?.children;
      // the glow around the pill follows the voice
      const avg = levels.current.slice(-6).reduce((a, b) => a + b, 0) / 6;
      pill.current?.style.setProperty("--lvl", Math.min(1, avg * 1.4).toFixed(3));
      if (el) {
        for (let i = 0; i < BARS; i++) {
          // the middle of the row moves most, like a voice print
          const shape = 0.45 + 0.55 * Math.sin((Math.PI * (i + 0.5)) / BARS);
          const target = Math.max(0.12, levels.current[i] * shape);
          shown[i] += (target - shown[i]) * 0.35;
          (el[i] as HTMLElement).style.transform = `scaleY(${shown[i].toFixed(3)})`;
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  useEffect(() => {
    if (phase !== "listening") return;
    const t0 = Date.now();
    const id = setInterval(() => setSeconds((Date.now() - t0) / 1000), 250);
    return () => clearInterval(id);
  }, [phase]);

  // the tick has its moment, then the pill goes (the shell hides the window just after)
  useEffect(() => {
    if (phase !== "done") return;
    const id = setTimeout(() => setLeaving(true), 780);
    return () => clearTimeout(id);
  }, [phase]);

  if (phase === "idle") return null;
  const keys = hotkeyLabels(config.hotkey).join(" + ");
  const hint = config.activation === "hold" ? "Release to finish" : `${keys} to finish`;
  const showText = (phase === "listening" || phase === "finishing") && (text || tentative);
  // the pill takes the width each moment needs, and moves between them smoothly
  const width = { starting: 184, listening: 252, finishing: 196, done: 44 }[phase as string];

  return (
    <div className="ov-stage" role="status" aria-live="polite">
      {phase === "error" && message && <div className="ov-glass ov-text ov-in">{message}</div>}
      {phase === "listening" && !showText && tip && <div className="ov-glass ov-text ov-tip ov-in">{tip}</div>}
      {showText && (
        <div className="ov-glass ov-text ov-in">
          <span>
            {text}
            {tentative && <span className="tentative"> {tentative}</span>}
          </span>
        </div>
      )}
      <div
        ref={pill}
        className={`ov-glass ov-pill ov-in ov-${phase} ${leaving ? "ov-out" : ""}`}
        style={width ? { width } : undefined}
      >
        {phase === "done" ? (
          <svg className="ov-tick" viewBox="0 0 24 24" aria-label="Inserted">
            <path d="M5.5 12.5l4.2 4.2L18.5 7.5" />
          </svg>
        ) : (
          <>
            <span className={`ov-dot ${phase === "listening" ? "listening" : ""} ${phase === "error" ? "bad" : ""}`}>
              {phase === "error" ? (
                <AlertTriangle size={15} />
              ) : phase === "listening" ? (
                <Mic size={15} strokeWidth={2.2} />
              ) : (
                <Loader2 size={15} className="ov-spin" />
              )}
            </span>
            {phase === "listening" ? (
              <>
                <div className="ov-bars" ref={bars} aria-hidden>
                  {Array.from({ length: BARS }, (_, i) => (
                    <i key={i} />
                  ))}
                </div>
                <span className="ov-time" title={hint}>
                  {fmt(seconds)}
                </span>
              </>
            ) : (
              <span className={`ov-label ${phase === "error" ? "" : "muted"} ${phase === "finishing" ? "ov-shimmer" : ""}`}>
                {phase === "starting" && "Getting ready…"}
                {phase === "finishing" && (config.mode === "onstop" ? "Writing it out…" : "Finishing…")}
                {phase === "error" && "Dictation could not start"}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
