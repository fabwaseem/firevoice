/* A soft generated soundtrack for the first run: warm pad chords that change every few seconds, with an occasional
 * high note through an echo. Made with Web Audio on the spot (no audio files), quiet, and it fades in and out. */

const CHORDS = [
  [130.81, 196.0, 246.94, 293.66, 329.63], // Cmaj9
  [110.0, 164.81, 196.0, 246.94, 261.63], // Am9
  [87.31, 130.81, 164.81, 220.0, 261.63], // Fmaj7
  [98.0, 146.83, 196.0, 220.0, 293.66], // G6sus2
];
const BELLS = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5]; // C major pentatonic, upper octave
const CHORD_S = 7;
const LEVEL = 0.07;

interface Player {
  ctx: AudioContext;
  master: GainNode;
  timers: number[];
}

let player: Player | null = null;

function voice(ctx: AudioContext, out: AudioNode, freq: number, t: number, dur: number, peak: number) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + dur * 0.35);
  g.gain.linearRampToValueAtTime(peak * 0.8, t + dur * 0.75);
  g.gain.linearRampToValueAtTime(0, t + dur + 1.5);
  g.connect(out);
  for (const [type, detune] of [["sine", -6], ["triangle", 7]] as const) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 1.6);
  }
}

function bell(ctx: AudioContext, out: AudioNode, t: number) {
  const f = BELLS[Math.floor(Math.random() * BELLS.length)];
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  o.frequency.value = f;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.12, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 3);
}

/** Start the soundtrack (call from a click, so the browser lets it play). Safe to call twice. */
export function startAmbient() {
  if (player) return;
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const master = ctx.createGain();
  master.gain.setValueAtTime(0, ctx.currentTime);
  master.gain.linearRampToValueAtTime(LEVEL, ctx.currentTime + 3);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1400;
  filter.Q.value = 0.4;
  // the filter breathes slowly
  const lfo = ctx.createOscillator();
  const lfoDepth = ctx.createGain();
  lfo.frequency.value = 0.05;
  lfoDepth.gain.value = 500;
  lfo.connect(lfoDepth).connect(filter.frequency);
  lfo.start();
  // an echo for the bells
  const delay = ctx.createDelay(2);
  delay.delayTime.value = 0.42;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.38;
  delay.connect(feedback).connect(delay);
  const bells = ctx.createGain();
  bells.gain.value = 0.5;
  bells.connect(filter);
  bells.connect(delay);
  delay.connect(filter);
  filter.connect(master).connect(ctx.destination);

  const p: Player = { ctx, master, timers: [] };
  let n = 0;
  const chord = () => {
    const t = ctx.currentTime + 0.05;
    for (const f of CHORDS[n % CHORDS.length]) voice(ctx, filter, f, t, CHORD_S, 0.05);
    n++;
  };
  chord();
  p.timers.push(window.setInterval(chord, CHORD_S * 1000));
  const nextBell = () => {
    bell(ctx, bells, ctx.currentTime + 0.05);
    p.timers.push(window.setTimeout(nextBell, 2200 + Math.random() * 3800));
  };
  p.timers.push(window.setTimeout(nextBell, 2500));
  player = p;
}

/** Fade the soundtrack out and release the audio device. */
export function stopAmbient() {
  const p = player;
  if (!p) return;
  player = null;
  for (const t of p.timers) {
    clearInterval(t);
    clearTimeout(t);
  }
  const now = p.ctx.currentTime;
  p.master.gain.cancelScheduledValues(now);
  p.master.gain.setValueAtTime(p.master.gain.value, now);
  p.master.gain.linearRampToValueAtTime(0, now + 1.2);
  window.setTimeout(() => void p.ctx.close().catch(() => {}), 1400);
}

export const ambientPlaying = () => player != null;
