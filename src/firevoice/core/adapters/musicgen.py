"""MusicGen small (Meta, weights CC-BY-NC-4.0, 32 kHz): music beds from a description.
venv: <engines>/sfx (transformers). The prompt describes the music ("calm lo-fi piano, warm, slow").

params: duration (s, 2-30), guidance (how closely to follow the prompt, 1-6).
"""
from __future__ import annotations

from ...paths import weights
from .base import Adapter

WEIGHTS = weights("musicgen-small")


class MusicGenAdapter(Adapter):
    name = "musicgen"
    sr = 32000
    needs_reference = False
    supports_design = False
    license = "CC-BY-NC-4.0"
    commercial = False
    vram_gb = 2.5

    def _load(self) -> None:
        import torch
        from transformers import AutoProcessor, MusicgenForConditionalGeneration
        src = str(WEIGHTS) if (WEIGHTS / "config.json").exists() else "facebook/musicgen-small"
        dev = self.device or "cuda"
        self.proc = AutoProcessor.from_pretrained(src)
        self.m = MusicgenForConditionalGeneration.from_pretrained(src, torch_dtype=torch.float16 if dev.startswith("cuda") else torch.float32).to(dev).eval()
        self.sr = int(self.m.config.audio_encoder.sampling_rate)
        self.dev = dev

    def _prepare_voice(self, ref_path, ref_text, desc):
        return {}

    def _synth(self, text, cond, params, seed):
        import torch
        dur = float(min(30.0, max(2.0, params.get("duration", 8.0))))
        inp = self.proc(text=[text], padding=True, return_tensors="pt").to(self.dev)
        torch.manual_seed(int(seed))   # sampling: the same seed gives the same music
        with torch.inference_mode():
            audio = self.m.generate(**inp, do_sample=True, guidance_scale=float(params.get("guidance", 3.0)), max_new_tokens=int(dur * 50))
        return audio[0, 0].float().cpu().numpy()
