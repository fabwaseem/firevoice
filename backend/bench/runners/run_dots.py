"""dots.tts (RedNote HiLab, 2B, Apache-2.0, 48 kHz). venv: .envs/dots
  --variant soar (default, best similarity) | mf (MeanFlow-distilled, fast)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

W = C.ROOT / ".envs" / "weights"


def main():
    a = C.parse_args("dots", extra=lambda p: p.add_argument("--variant", default="soar"))
    engine = "dots" if a.variant == "soar" else f"dots-{a.variant}"
    if a.out.endswith("dots") and a.variant != "soar":
        a.out = a.out + "-" + a.variant

    def load():
        from dots_tts.runtime import DotsTtsRuntime
        local = W / f"dots-tts-{a.variant}"
        src = str(local) if local.exists() else f"dots-studio/dots.tts-{a.variant}"
        m = DotsTtsRuntime.from_pretrained(src, precision="bfloat16", optimize=False)
        return m, 48000

    def synth(m, text, item):
        kw = dict(text=text, prompt_audio_path=a.ref, prompt_text=a.ref_text)
        if a.variant == "soar":
            kw.update(num_steps=10, guidance_scale=1.2)
        r = m.generate(**kw)
        return r["audio"]

    C.run(engine, a, load, synth, supports_tags=False, notes=f"dots.tts-{a.variant}, Apache-2.0, 48 kHz")


if __name__ == "__main__":
    main()
