"""Chatterbox voice changer (MIT): speech-to-speech. It keeps the timing, words and delivery of a source recording and
swaps the voice for a library voice. Runs in the main venv; weights come with Chatterbox.

The source recording travels as params["source"] (a path the worker can read); the target voice is the prepared
reference clip.
"""
from __future__ import annotations

from .base import Adapter


class ChatterboxVCAdapter(Adapter):
    name = "chatterbox-vc"
    sr = 24000
    needs_reference = True
    license = "MIT"
    commercial = True
    vram_gb = 3.0

    def _load(self) -> None:
        from chatterbox.vc import ChatterboxVC
        self.m = ChatterboxVC.from_pretrained(self.device or "cuda")
        self.sr = int(getattr(self.m, "sr", 24000))

    def _prepare_voice(self, ref_path, ref_text, desc):
        if not ref_path:
            raise ValueError("the voice changer needs a voice with a reference clip")
        return {"ref": ref_path}

    def _synth(self, text, cond, params, seed):
        src = params.get("source")
        if not src:
            raise ValueError("no source recording given")
        wav = self.m.generate(audio=src, target_voice_path=cond["ref"])
        return wav.squeeze()
