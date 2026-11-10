"""MusicGen small (Meta, weights CC-BY-NC-4.0, 32 kHz): music beds and tracks from a description.
venv: <engines>/sfx (transformers). The prompt describes the music ("calm lo-fi piano, warm, slow").

MusicGen makes at most 30 s in one pass. Longer tracks (up to MAX_SECONDS) are continued: each further pass hears the
last 10 s of the music so far and adds up to 20 s more, and the seam is blended over 80 ms. The pieces stream out as they
are made, so a long render can be stopped between passes.

params: duration (s, 2-180), guidance (how closely to follow the prompt, 1-6).
"""
from __future__ import annotations

import math

import numpy as np

from ...paths import weights
from .base import Adapter

WEIGHTS = weights("musicgen-small")
MAX_SECONDS = 180.0
PASS_S = 30.0      # what one pass can make
CONTEXT_S = 10.0   # how much of the music so far a continuation hears
BLEND_S = 0.08     # crossfade at each seam
FADE_S = 2.5       # a soft ending on tracks longer than one pass


class MusicGenAdapter(Adapter):
    name = "musicgen"
    sr = 32000
    needs_reference = False
    supports_design = False
    supports_streaming = True
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
        return np.concatenate(list(self._synth_stream(text, cond, params, seed)))

    def _generate(self, text: str, guidance: float, seconds: float, context=None) -> np.ndarray:
        """One pass: `seconds` of new music, after `context` (the music so far) when given. Returns what the model
        decodes: for a continuation that starts with the context again."""
        import torch
        fps = float(self.m.config.audio_encoder.frame_rate)
        if context is None:
            inp = self.proc(text=[text], padding=True, return_tensors="pt")
        else:
            inp = self.proc(audio=[context], sampling_rate=self.sr, text=[text], padding=True, return_tensors="pt")
        inp = inp.to(self.dev)
        if "input_values" in inp:
            inp["input_values"] = inp["input_values"].to(self.m.dtype)
        with torch.inference_mode():
            out = self.m.generate(**inp, do_sample=True, guidance_scale=guidance, max_new_tokens=int(math.ceil(seconds * fps)))
        return out[0, 0].float().cpu().numpy()

    def _synth_stream(self, text, cond, params, seed):
        import torch
        dur = float(min(MAX_SECONDS, max(2.0, params.get("duration", 8.0))))
        guidance = float(params.get("guidance", 3.0))
        sr = self.sr
        total, blend, ctx_n = int(dur * sr), int(BLEND_S * sr), int(CONTEXT_S * sr)
        torch.manual_seed(int(seed))   # sampling: the same seed gives the same music
        sent = 0

        def take(x):
            nonlocal sent
            x = x[:max(0, total - sent)]
            sent += len(x)
            return x

        cur = self._generate(text, guidance, min(dur, PASS_S))
        while sent + len(cur) < total and len(cur) > blend:
            context = cur[-ctx_n:]
            hold = cur[-blend:]
            yield take(cur[:-blend])        # the last 80 ms wait for the seam
            more = min(PASS_S - CONTEXT_S, (total - sent - blend) / sr + 0.25)
            out = self._generate(text, guidance, more, context)
            cut = len(context) if len(out) > len(context) + blend else 0     # the continuation starts with its context
            if cut >= blend:
                ramp = np.linspace(0.0, 1.0, blend, dtype=np.float32)
                hold = hold * (1 - ramp) + out[cut - blend:cut] * ramp
            new = out[cut:]
            if not len(new):
                break
            cur = np.concatenate([hold, new])
        last = take(cur).astype(np.float32)
        if dur > PASS_S and len(last):
            f = min(len(last), int(FADE_S * sr))
            last[-f:] *= np.linspace(1.0, 0.0, f, dtype=np.float32) ** 2
        yield last
