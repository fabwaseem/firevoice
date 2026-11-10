"""IndexTTS-2.5 (Bilibili IndexTeam; bilibili Model Use License, non-commercial). Runs from the index-tts checkout
(<engines>/indextts-repo, pinned) in the indextts venv; weights in <weights>/indextts-2.5.

Over IndexTTS-2: about 2.3x faster, Japanese, Spanish and Arabic, and native speech-rate control. Emotion stays
independent of the voice. params:
  language      : zh | en | ja | es | ar (default from the request, else en)
  rate          : speech rate, 0.5-2.0 (1.0 normal, above 1 faster); applied natively, not by stretching
  emo_vector    : 8 floats [happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]
  emo_ref       : an emotion reference clip;  emo_alpha : 0..1 strength
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from ...paths import engines_dir, weights
from .base import Adapter

WEIGHTS = weights("indextts-2.5")
LANGS = {"zh", "en", "ja", "es", "ar"}


class IndexTTS25Adapter(Adapter):
    name = "indextts25"
    sr = 22050
    needs_reference = True
    supports_instruct = False
    license = "bilibili Model Use License (non-commercial)"
    commercial = False
    vram_gb = 6.0

    def _load(self) -> None:
        os.chdir(engines_dir() / "indextts-repo")
        from indextts.infer_v2_5 import IndexTTS2
        self.m = IndexTTS2(cfg_path=str(WEIGHTS / "config.yaml"), model_dir=str(WEIGHTS), use_bf16=True, use_cuda_kernel=False,
                           use_deepspeed=False)
        self.tmp = Path(tempfile.mkdtemp(prefix="indextts25-"))

    def _synth(self, text, cond, params, seed):
        import soundfile as sf
        lang = str(params.get("language") or "en").lower().split("-")[0]
        lang = lang if lang in LANGS else "en"
        out = self.tmp / f"{seed}_{abs(hash(text)) % 10**8}.wav"
        kw = {"duration_factor": 1.0 / max(0.5, min(2.0, float(params.get("rate", 1.0))))}
        if params.get("emo_vector"):
            kw.update(emo_vector=[float(x) for x in params["emo_vector"]], emo_alpha=float(params.get("emo_alpha", 0.8)))
        elif params.get("emo_ref"):
            kw.update(emo_audio_prompt=params["emo_ref"], emo_alpha=float(params.get("emo_alpha", 1.0)))
        try:
            self.m.infer(spk_audio_prompt=cond["ref"], text=text, output_path=str(out), lang=lang, verbose=False, **kw)
        except ImportError:
            # ja/es text normalisation needs NeMo's pynini, which has no Windows wheel: speak the text as written
            self.m.infer(spk_audio_prompt=cond["ref"], text=text, output_path=str(out), lang=lang, verbose=False, text_normalization=False, **kw)
        wav, sr = sf.read(str(out), dtype="float32")
        self.sr = int(sr)
        try:
            out.unlink()
        except OSError:
            pass
        return wav
