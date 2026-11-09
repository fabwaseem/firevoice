"""IndexTTS-2 (Bilibili; non-commercial license). venv: .envs/indextts, repo on PYTHONPATH (.envs/indextts-repo),
checkpoints in .envs/weights/indextts-2.

Emotion is independent of timbre: params may carry
  emo_vector  : 8 floats [happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]
  emo_text    : a free-text emotion description (uses the model's text->emotion head)
  emo_ref     : a path to an emotion reference clip
  emo_alpha   : 0..1 strength
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from ...paths import engines_dir, weights
from .base import Adapter

WEIGHTS = weights("indextts-2")


class IndexTTS2Adapter(Adapter):
    name = "indextts2"
    sr = 22050
    needs_reference = True
    supports_instruct = True
    license = "bilibili Model Use License (non-commercial)"
    commercial = False
    vram_gb = 6.0

    def _load(self) -> None:
        os.chdir(engines_dir() / "indextts-repo")
        from indextts.infer_v2 import IndexTTS2
        self.m = IndexTTS2(cfg_path=str(WEIGHTS / "config.yaml"), model_dir=str(WEIGHTS), use_fp16=True, use_cuda_kernel=False, use_deepspeed=False)
        self.tmp = Path(tempfile.mkdtemp(prefix="indextts-"))

    def _synth(self, text, cond, params, seed):
        import soundfile as sf
        out = self.tmp / f"{seed}_{abs(hash(text)) % 10**8}.wav"
        kw = {}
        if params.get("emo_vector"):
            kw.update(emo_vector=[float(x) for x in params["emo_vector"]], emo_alpha=float(params.get("emo_alpha", 0.8)))
        elif params.get("emo_text") or params.get("instruct"):
            kw.update(use_emo_text=True, emo_text=params.get("emo_text") or params.get("instruct"), emo_alpha=float(params.get("emo_alpha", 0.6)))
        elif params.get("emo_ref"):
            kw.update(emo_audio_prompt=params["emo_ref"], emo_alpha=float(params.get("emo_alpha", 1.0)))
        self.m.infer(spk_audio_prompt=cond["ref"], text=text, output_path=str(out), verbose=False, **kw)
        wav, sr = sf.read(str(out), dtype="float32")
        self.sr = int(sr)
        try:
            out.unlink()
        except OSError:
            pass
        return wav
