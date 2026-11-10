"""Breeze TTS 2 (BreezeBlue, 3B, research/non-commercial weights). venv: .envs/breeze

Loads the model once through firevoice's BreezeRuntime (which drives the cloned repo's own modules the way its
infer.py does) and renders every item in-process, so per-item timings are real synthesis time. If the resident
runtime cannot be imported it falls back to one infer.py process per item (timings then include model load).
  --mode clone     : --ref + transcript                                   (cfg 1)
  --mode design    : --voice-desc as the instruction, no reference        (cfg 4)
  --mode direction : --ref + transcript + a style instruction per item    (cfg 4)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

sys.path.insert(0, str(C.ROOT / "src"))

STYLE_DIRECTION = {
    "horror": "Speak in a low, tense, menacing whisper-like voice, slow and dreadful.",
    "excited": "Speak with high energy and genuine excitement, fast and bright.",
    "calm": "Speak slowly, softly and soothingly, like a meditation guide.",
    "storyteller": "Narrate warmly like an audiobook storyteller, with gentle drama.",
    "explainer": "Speak clearly and confidently like a friendly expert explaining to a beginner.",
    "conversational": "Speak casually and naturally, like talking to a friend.",
}


def main():
    a = C.parse_args("breeze", extra=lambda p: p.add_argument("--fast", action="store_true", help="enable the repo CUDA-graph fast path (~14 GB VRAM)"))
    engine = "breeze" if a.mode == "clone" else f"breeze-{a.mode}"
    if a.out.endswith("breeze") and a.mode != "clone":
        a.out += "-" + a.mode

    def load():
        from firevoice.core.adapters.breeze import make_runtime
        rt, resident = make_runtime(fast=bool(getattr(a, "fast", False)))
        print(f"[breeze] {'resident model' if resident else 'infer.py per item (timings include model load)'}", file=sys.stderr)
        return rt, int(rt.sr)

    def synth(rt, text, item):
        kw = {"seed": a.seed}
        if a.mode in ("clone", "direction"):
            kw.update(ref=a.ref, ref_text=a.ref_text)
        if a.mode == "design":
            kw.update(instruction=a.voice_desc, cfg_scale=4.0)
        if a.mode == "direction":
            kw.update(instruction=STYLE_DIRECTION.get(item.get("style"), STYLE_DIRECTION["conversational"]), cfg_scale=4.0)
        return rt.synth(text, **kw)

    C.run(engine, a, load, synth, supports_tags=False,
          notes="Breeze TTS 2 3B, non-commercial weights, 24 kHz, eager attention, resident model via firevoice BreezeRuntime")


if __name__ == "__main__":
    main()
