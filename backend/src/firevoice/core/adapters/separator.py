"""Voice/music separation and neural denoising (audio-separator, MIT, running UVR RoFormer models; model licences vary).
venv: <engines>/separator; models in <weights>/separator.

Not speech synthesis: params["source"] is a recording, params["mode"] one of
  vocals    the voice, apart from music and effects (BS-RoFormer)
  denoise   the voice, apart from noise (Mel-Band RoFormer denoise)
  dereverb  the voice without room echo (Mel-Band RoFormer dereverb)
The kept part (the voice) is returned; the rest (music, noise, echo) is written to params["other_out"] when given.
"""
from __future__ import annotations

import logging
import shutil
import tempfile
from pathlib import Path

from ...paths import weights
from .base import Adapter

MODELS = {"vocals": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
          "denoise": "denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt",
          "dereverb": "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt"}
KEEP = {"vocals": ("(vocals)",), "denoise": ("(dry)", "(no noise)", "(vocals)"), "dereverb": ("(noreverb)", "(no reverb)", "(dry)")}


class SeparatorAdapter(Adapter):
    name = "separator"
    sr = 44100
    needs_reference = False
    license = "MIT (audio-separator); UVR model licences vary"
    commercial = False
    vram_gb = 3.0

    def _load(self) -> None:
        from audio_separator.separator import Separator
        self.out = Path(tempfile.mkdtemp(prefix="fv-sep-"))
        self.s = Separator(model_file_dir=str(weights("separator")), output_dir=str(self.out), output_format="WAV", log_level=logging.WARNING)
        self.current = None

    def _prepare_voice(self, ref_path, ref_text, desc):
        return {}

    def _synth(self, text, cond, params, seed):
        import soundfile as sf
        src = params.get("source")
        if not src:
            raise ValueError("no recording given")
        mode = params.get("mode", "vocals")
        if mode not in MODELS:
            raise ValueError(f"mode must be one of {', '.join(MODELS)}")
        if self.current != mode:
            self.s.load_model(model_filename=MODELS[mode])
            self.current = mode
        for f in self.out.glob("*"):
            f.unlink(missing_ok=True)
        files = [self.out / Path(f).name for f in self.s.separate(src)]
        keep = next((f for f in files if any(k in f.name.lower() for k in KEEP[mode])), files[0])
        other = next((f for f in files if f != keep), None)
        if other is not None and params.get("other_out"):
            shutil.copyfile(other, params["other_out"])
        a, sr = sf.read(str(keep), dtype="float32", always_2d=False)
        self.sr = int(sr)
        return a
