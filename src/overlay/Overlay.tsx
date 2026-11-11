import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Mic } from "lucide-react";
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
  const bars = useRef<HTMLDivElement>(null);
  const levels = useRef<number[]>(Array(BARS).fill(0));
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const subs = [
      onDictation<DictationStateEvent>("dictation", (e) => {
        const cfg = savedConfig();
        const was = phaseRef.current;
        if (e.state === "starting") {
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
        // a dictation that ends with text shows "Inserted" for a moment before the window goes
        setPhase(e.state === "idle" && was === "finishing" ? "done" : e.state);
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

  if (phase === "idle") return null;
  const keys = hotkeyLabels(config.hotkey).join(" + ");
  const hint = config.activation === "hold" ? "Release to finish" : `${keys} to finish`;
  const showText = (phase === "listening" || phase === "finishing" || phase === "done") && (text || tentative);

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
      <div className="ov-glass ov-pill ov-in">
        <span className={`ov-dot ${phase === "listening" ? "listening" : ""} ${phase === "error" ? "bad" : ""} ${phase === "done" ? "ok" : ""}`}>
          {phase === "error" ? (
            <AlertTriangle size={15} />
          ) : phase === "done" ? (
            <Check size={16} strokeWidth={2.6} />
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
          <span className={`ov-label ${phase === "error" ? "" : "muted"}`}>
            {phase === "starting" && "Getting ready…"}
            {phase === "finishing" && (config.mode === "onstop" ? "Writing it out…" : "Finishing…")}
            {phase === "done" && "Inserted"}
            {phase === "error" && "Dictation could not start"}
          </span>
        )}
      </div>
    </div>
  );
}
