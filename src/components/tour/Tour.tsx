import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { create } from "zustand";
import { ArrowLeft, ArrowRight, MousePointerClick, X } from "lucide-react";
import { Button, Kbd } from "@/components/ui";
import { hotkeyLabels } from "@/lib/dictation";
import { useDictation } from "@/stores/dictation";
import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/utils";

/* A short guided tour of the app after the first run: a spotlight on one thing at a time (a sidebar button, then the
 * page it opens), with a card that says what it is for. Clicking a highlighted sidebar button opens its page and moves
 * the tour on, so the user learns by doing it. Steps whose element is not on screen wait for it (pages load lazily). */

interface Step {
  /** the element to highlight: [data-tour="…"] */
  target: string;
  /** the page this step is on (the tour opens it when the step starts) */
  route?: string;
  title: string;
  body: React.ReactNode;
  /** a sidebar button: clicking it opens `next` and moves on */
  clickTo?: string;
  side: "right" | "bottom" | "left" | "top";
}

function DictationKeys() {
  const hotkey = useDictation((s) => s.config.hotkey);
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {hotkeyLabels(hotkey).map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );
}

const STEPS: Step[] = [
  {
    target: "nav-/speak",
    route: "/",
    clickTo: "/speak",
    side: "right",
    title: "Speak: text to voice",
    body: "This is where most voices are made. Click Speak to open it.",
  },
  {
    target: "speak-editor",
    route: "/speak",
    side: "right",
    title: "Write, then press play",
    body: "Type or paste your script here, choose a voice above, and FireVoice reads it out. Long scripts are fine. Delivery styles (excited, sad, whisper) come with the Firebrand engine.",
  },
  {
    target: "nav-/voices",
    route: "/speak",
    clickTo: "/voices",
    side: "right",
    title: "100 voices, and your own",
    body: "Browse ready-made voices, or copy one from a short clip. Click Voices to look.",
  },
  {
    target: "nav-/dictation",
    route: "/voices",
    clickTo: "/dictation",
    side: "right",
    title: "Dictation: type with your voice",
    body: "Speak in any program, a browser, a chat or a document, and FireVoice types what you say. Click Dictation.",
  },
  {
    target: "dictation-stage",
    route: "/dictation",
    side: "bottom",
    title: "Turn it on, then use the hotkey",
    body: (
      <>
        Switch dictation on here. Then, in any app, press <DictationKeys /> and speak; press it again to finish. You can test it right on this page.
      </>
    ),
  },
  {
    target: "dictation-tabs",
    route: "/dictation",
    side: "bottom",
    title: "Make it yours",
    body: "Add the names you use and snippets you say often, let the writing assistant polish what you dictate (or translate it), and find every dictation again in History.",
  },
  {
    target: "nav-/settings",
    route: "/dictation",
    side: "right",
    title: "That's the tour",
    body: "Settings has the rest: engines, storage, the API and appearance. You can take this tour again from Settings at any time.",
  },
];

interface TourState {
  step: number | null;
  /** start once the app is on screen (asked for at the end of the first run) */
  pending: boolean;
  queue: () => void;
  start: () => void;
  stop: () => void;
  go: (n: number) => void;
}

export const useTour = create<TourState>()((set) => ({
  step: null,
  pending: false,
  queue: () => set({ pending: true }),
  start: () => set({ step: 0, pending: false }),
  stop: () => {
    set({ step: null });
    useSettings.getState().set({ tourDone: true });
  },
  go: (n) => (n >= STEPS.length ? useTour.getState().stop() : set({ step: Math.max(0, n) })),
}));

const PAD = 8;

/** Where an element is on screen, kept up to date while it moves (scrolling, layout, lazy pages). */
function useRect(selector: string | null) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!selector) return;
    let raf = 0;
    let last = "";
    const tick = () => {
      const el = document.querySelector(`[data-tour="${selector}"]`);
      const r = el?.getBoundingClientRect() ?? null;
      const key = r ? `${r.x}|${r.y}|${r.width}|${r.height}` : "";
      if (key !== last) {
        last = key;
        setRect(r && r.width > 0 ? r : null);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [selector]);
  return rect;
}

/** The tour, mounted once in the app shell (inside the router). */
export function Tour() {
  const step = useTour((s) => s.step);
  const go = useTour((s) => s.go);
  const stop = useTour((s) => s.stop);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const s = step == null ? null : STEPS[step];
  const rect = useRect(s?.target ?? null);

  // asked for at the end of the first run: start once the app has settled on screen
  const pending = useTour((t) => t.pending);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => useTour.getState().start(), 900);
    return () => clearTimeout(t);
  }, [pending]);

  // a step opens its page
  useEffect(() => {
    if (s?.route && pathname !== s.route) navigate(s.route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // the user followed the hint and opened the page (a change of page, not just being on it): on to the next step
  const prevPath = useRef(pathname);
  useEffect(() => {
    const before = prevPath.current;
    prevPath.current = pathname;
    if (s?.clickTo && step != null && before !== pathname && pathname === s.clickTo) go(step + 1);
  }, [pathname, s?.clickTo, step, go]);

  // Esc ends the tour; arrow keys move through it
  const next = useCallback(() => {
    if (step == null) return;
    if (s?.clickTo) navigate(s.clickTo);
    else go(step + 1);
  }, [step, s?.clickTo, navigate, go]);
  useEffect(() => {
    if (step == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft" && step > 0) go(step - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, next, go, stop]);

  if (step == null || !s) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const hole = rect && { x: rect.x - PAD, y: rect.y - PAD, w: rect.width + PAD * 2, h: rect.height + PAD * 2 };
  const last = step === STEPS.length - 1;

  // the card sits beside the highlight on the first side with room for it (the step's own side first), kept inside
  // the window; with no room anywhere it sits in the highlight's lower right corner
  const CARD_W = 340;
  const CARD_H = 230;
  const M = 16;
  let cardStyle: React.CSSProperties = { left: vw / 2 - CARD_W / 2, top: vh / 2 - CARD_H / 2 };
  if (hole) {
    const clampY = (y: number) => Math.min(Math.max(M, y), vh - CARD_H - M);
    const clampX = (x: number) => Math.min(Math.max(M, x), vw - CARD_W - M);
    const sides: Record<string, { fits: boolean; at: React.CSSProperties }> = {
      right: { fits: hole.x + hole.w + M + CARD_W + M <= vw, at: { left: hole.x + hole.w + M, top: clampY(hole.y - 12) } },
      left: { fits: hole.x - M - CARD_W >= M, at: { left: hole.x - M - CARD_W, top: clampY(hole.y) } },
      bottom: { fits: hole.y + hole.h + M + CARD_H + M <= vh, at: { left: clampX(hole.x + 24), top: hole.y + hole.h + M } },
      top: { fits: hole.y - M - CARD_H >= M, at: { left: clampX(hole.x + 24), top: hole.y - M - CARD_H } },
    };
    const pick = [s.side, "right", "left", "bottom", "top"].find((k) => sides[k].fits);
    cardStyle = pick ? sides[pick].at : { left: clampX(hole.x + hole.w - CARD_W - 24), top: clampY(hole.y + hole.h - CARD_H - 24) };
  }

  // four blocks around the hole take the clicks outside it; the hole itself stays clickable
  const blocks = hole
    ? [
        { left: 0, top: 0, width: vw, height: Math.max(0, hole.y) },
        { left: 0, top: hole.y + hole.h, width: vw, height: Math.max(0, vh - hole.y - hole.h) },
        { left: 0, top: hole.y, width: Math.max(0, hole.x), height: hole.h },
        { left: hole.x + hole.w, top: hole.y, width: Math.max(0, vw - hole.x - hole.w), height: hole.h },
      ]
    : [{ left: 0, top: 0, width: vw, height: vh }];

  return (
    <div className="pointer-events-none fixed inset-0 z-[80]" role="dialog" aria-modal="true" aria-label={`Tour, step ${step + 1} of ${STEPS.length}: ${s.title}`}>
      <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden>
        <defs>
          <mask id="tour-hole">
            <rect width="100%" height="100%" fill="white" />
            {hole && <rect x={hole.x} y={hole.y} width={hole.w} height={hole.h} rx={14} fill="black" style={{ transition: "all 0.35s cubic-bezier(.2,.8,.2,1)" }} />}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(8,9,12,0.62)" mask="url(#tour-hole)" />
      </svg>
      {blocks.map((b, i) => (
        <div key={i} className="pointer-events-auto absolute" style={b} onClick={(e) => e.stopPropagation()} />
      ))}
      {hole && (
        <div
          className="tour-ring pointer-events-none absolute rounded-[14px]"
          style={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h, transition: "all 0.35s cubic-bezier(.2,.8,.2,1)" }}
        />
      )}
      <div
        key={step}
        className="surface-raised onb-in pointer-events-auto absolute w-[340px] rounded-2xl p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.55)]"
        style={{ ...cardStyle, transition: "left 0.35s, top 0.35s" }}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex gap-1.5" aria-hidden>
            {STEPS.map((_, n) => (
              <span key={n} className={cn("h-1.5 rounded-full transition-all", n === step ? "w-5 bg-fire" : n < step ? "w-1.5 bg-fire/50" : "w-1.5 bg-surface-3")} />
            ))}
          </div>
          <button type="button" onClick={stop} className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="End the tour">
            <X className="size-4" />
          </button>
        </div>
        <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-ink">{s.title}</h2>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{s.body}</p>
        {s.clickTo && hole && (
          <p className="mt-3 flex items-center gap-2 text-[12.5px] font-medium text-fire">
            <MousePointerClick className="size-4" /> Click the highlighted button
          </p>
        )}
        <div className="mt-4 flex items-center gap-2">
          {step > 0 && (
            <Button variant="ghost" size="sm" leading={<ArrowLeft className="size-3.5" />} onClick={() => go(step - 1)}>
              Back
            </Button>
          )}
          <span className="ml-auto text-[12px] text-faint tabular">
            {step + 1} of {STEPS.length}
          </span>
          <Button variant="primary" size="sm" trailing={!last && <ArrowRight className="size-3.5" />} onClick={next}>
            {last ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
