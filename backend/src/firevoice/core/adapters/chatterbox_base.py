"""Original Chatterbox 500M (MIT): has a built-in voice, exaggeration and CFG knobs. Runs in the main venv."""
from __future__ import annotations

from pathlib import Path

from .base import Adapter


class ChatterboxAdapter(Adapter):
    name = "chatterbox"
    sr = 24000
    needs_reference = False
    license = "MIT"
    commercial = True
    vram_gb = 4.0

    def _load(self) -> None:
        from chatterbox.tts import ChatterboxTTS
        self.m = ChatterboxTTS.from_pretrained(device=self.device)
        self.sr = int(self.m.sr)
        self.builtin = self.m.conds

    def _prepare_voice(self, ref_path, ref_text, desc):
        if not ref_path:
            return self.builtin
        self.m.prepare_conditionals(ref_path, exaggeration=0.5)
        return self.m.conds

    def _synth(self, text, cond, params, seed):
        self.m.conds = cond if cond is not None else self.builtin
        wav = self.m.generate(text, exaggeration=float(params.get("exaggeration", 0.5)), cfg_weight=float(params.get("cfg", 0.5)), temperature=float(params.get("temperature", 0.8)))
        return wav.squeeze()
