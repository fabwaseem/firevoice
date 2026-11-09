"""Kokoro-82M (Apache-2.0, 24 kHz): preset voices only; `desc` names the Kokoro voice (e.g. am_michael, af_heart,
bm_george, bf_emma). venv: .envs/kokoro"""
from __future__ import annotations

import numpy as np

from .base import Adapter


class KokoroAdapter(Adapter):
    name = "kokoro"
    sr = 24000
    needs_reference = False
    supports_design = False
    license = "Apache-2.0"
    commercial = True
    vram_gb = 1.0

    def _load(self) -> None:
        from kokoro import KPipeline
        self.m = KPipeline(lang_code=self.extra.get("lang", "a"), device=self.device)

    def _prepare_voice(self, ref_path, ref_text, desc):
        """Kokoro only has presets. A voice's description may be a preset name ("af_heart"), mention one ("...made with
        Kokoro am_michael"), or be free text, which Kokoro would read as a missing preset and answer with silence."""
        import re
        m = re.search(r"\b([abefhijpz][fm]_[a-z]+)\b", desc or "")
        return {"voice": m.group(1) if m else "am_michael"}

    def _synth(self, text, cond, params, seed):
        voice = (cond or {}).get("voice", "am_michael")
        parts = [np.asarray(r.audio, dtype=np.float32) for r in self.m(text, voice=voice, speed=float(params.get("speed", 1.0)), split_pattern=None) if r.audio is not None]
        return np.concatenate(parts) if parts else np.zeros(0, np.float32)
