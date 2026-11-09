"""F5-TTS v1 Base (CC-BY-NC weights, 24 kHz). venv: .envs/f5"""
from __future__ import annotations

from .base import Adapter


class F5Adapter(Adapter):
    name = "f5"
    sr = 24000
    needs_reference = True
    needs_ref_text = True
    license = "CC-BY-NC-4.0 (weights)"
    commercial = False
    vram_gb = 3.0

    def _load(self) -> None:
        from f5_tts.api import F5TTS
        self.m = F5TTS(model="F5TTS_v1_Base", device=self.device)

    def _synth(self, text, cond, params, seed):
        wav, sr, _ = self.m.infer(ref_file=cond["ref"], ref_text=cond.get("ref_text") or "", gen_text=text, nfe_step=int(params.get("nfe_step", 32)),
                                  cfg_strength=float(params.get("cfg_strength", 2.0)), speed=float(params.get("speed", 1.0)), seed=seed,
                                  show_info=lambda *a, **k: None, progress=None)
        self.sr = int(sr)
        return wav
