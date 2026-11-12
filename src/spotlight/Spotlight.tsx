import { useEffect, useState } from "react";
import { hotkeyLabels, onDictation, type DictationStateEvent } from "@/lib/dictation";
import { DEFAULT_DICTATION, type DictationConfig } from "@/stores/dictation";

/** The first-dictation guide: the screen dims around the pill (the shell puts this window over the whole screen, under
 * the pill, and says where the pill is), with a word above it on what to do. It fades itself when listening ends. */

interface Spot {
  x: number;
  y: number;
}

function savedConfig(): DictationConfig {
  try {
    const raw = JSON.parse(localStorage.getItem("firevoice.dictation") ?? "{}");
    return { ...DEFAULT_DICTATION, ...(raw?.state?.config ?? {}) };
  } catch {
    return DEFAULT_DICTATION;
  }
}

export function Spotlight() {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [on, setOn] = useState(false);
  const [cfg, setCfg] = useState<DictationConfig>(DEFAULT_DICTATION);

  useEffect(() => {
    let frame = 0;
    const subs = [
      onDictation<Spot>("spotlight", (s) => {
        setCfg(savedConfig());
        setSpot(s);
        setOn(false);
        // one frame dark-less first, so the dim and the circle play in from the edges every time
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
      }),
      onDictation<DictationStateEvent>("dictation", (e) => {
        if (e.state !== "starting" && e.state !== "listening") setOn(false);
      }),
    ];
    return () => {
      cancelAnimationFrame(frame);
      for (const s of subs) s.then((off) => off()).catch(() => {});
    };
  }, []);

  if (!spot) return null;
  const keys = hotkeyLabels(cfg.hotkey);
  const how = cfg.activation === "hold" ? "Let go of" : "Press";
  const after = cfg.activation === "hold" ? "when you are done." : "again when you are done.";
  const where =
    cfg.mode === "realtime" ? "Your words appear where you are typing as you speak." : "When you stop, your words go in where you are typing.";
  const style = { "--x": `${spot.x}px`, "--y": `${spot.y}px` } as React.CSSProperties;

  return (
    <div className={`sp-root ${on ? "on" : ""}`} style={style} aria-hidden={!on}>
      <div className="sp-dim" />
      <div className="sp-ring" />
      <div className="sp-coach" role="status" aria-live="polite">
        <h2>FireVoice is listening</h2>
        <p>Say something, like a short message. {where}</p>
        <p className="sp-keys">
          {how}{" "}
          {keys.map((k) => (
            <kbd key={k}>{k}</kbd>
          ))}{" "}
          {after}
        </p>
      </div>
    </div>
  );
}
