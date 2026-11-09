"""dots.tts (RedNote HiLab, Apache-2.0, 48 kHz). venv: .envs/dots  (variant via adapter kwarg variant=soar|mf)"""
from __future__ import annotations

from pathlib import Path

from .base import Adapter

WEIGHTS = Path(__file__).resolve().parents[4] / ".envs" / "weights"


class DotsAdapter(Adapter):
    name = "dots"
    sr = 48000
    needs_reference = True
    needs_ref_text = True
    license = "Apache-2.0"
    commercial = True
    vram_gb = 8.0

    def _load(self) -> None:
        from dots_tts.runtime import DotsTtsRuntime
        variant = self.extra.get("variant", "soar")
        local = WEIGHTS / f"dots-tts-{variant}"
        src = str(local) if (local / "config.json").exists() else f"dots-studio/dots.tts-{variant}"
        self.variant = variant
        self.m = DotsTtsRuntime.from_pretrained(src, precision="bfloat16", optimize=False)

    def _synth(self, text, cond, params, seed):
        kw = dict(text=text, prompt_audio_path=cond["ref"], prompt_text=cond.get("ref_text") or None, language=params.get("language", "en"))
        if self.variant == "soar":
            kw.update(num_steps=int(params.get("num_steps", 10)), guidance_scale=float(params.get("guidance_scale", 1.2)))
        return self.m.generate(**kw)["audio"]
