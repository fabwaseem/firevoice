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
