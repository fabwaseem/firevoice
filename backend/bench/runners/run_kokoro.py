"""Kokoro-82M (Apache-2.0). Preset voices only, no cloning. venv: .envs/kokoro
  --voice-desc is ignored; use --kvoice (default am_michael for male refs, af_heart for female)."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402


def main():
    a = C.parse_args("kokoro", extra=lambda p: p.add_argument("--kvoice", default=None))
    voice = a.kvoice or ("af_heart" if "_f" in Path(a.ref).stem else "am_michael")

    def load():
        from kokoro import KPipeline
        m = KPipeline(lang_code="a", device="cuda")
        return m, 24000

    def synth(m, text, item):
        parts = [np.asarray(r.audio, dtype=np.float32) for r in m(text, voice=voice, speed=1.0, split_pattern=None) if r.audio is not None]
        return np.concatenate(parts) if parts else np.zeros(0, np.float32)

    C.run("kokoro", a, load, synth, supports_tags=False, notes=f"Kokoro-82M, Apache-2.0, 24 kHz, preset voice {voice}")


if __name__ == "__main__":
    main()
