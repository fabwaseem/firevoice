"""Ming-3.0-tts 0.5B (inclusionAI / Ant Group, MIT). Runs from the Ming-3.0-tts checkout (<engines>/ming-repo, pinned) in
the ming venv; weights in <weights>/ming-3.0-tts-0.5b. Loads its tokenizer with trust_remote_code from those weights.

Cloning from a clip plus its transcript, voice design from a description, inline paralinguistic tags, and 7 languages
(zh, en, es, fr, de, ko, ja). Text normalisation (pynini) is off: pynini has no reliable Windows wheel, and FireVoice
normalises text itself before it reaches the engine.
params: cfg (guidance, 1-4), language.
"""
from __future__ import annotations

import os

from ...paths import engines_dir, weights
from .base import Adapter

WEIGHTS = weights("ming-3.0-tts-0.5b")
LANG_NAMES = {"zh": "Chinese", "en": "English", "es": "Spanish", "fr": "French", "de": "German", "ko": "Korean", "ja": "Japanese"}


class MingAdapter(Adapter):
    name = "ming"
    sr = 44100
    needs_reference = False
    supports_design = True
    supports_tags = True
    license = "MIT"
    commercial = True
    vram_gb = 4.0

    def _load(self) -> None:
        os.chdir(engines_dir() / "ming-repo")
        from ming_tts import MingTTS
        self.m = MingTTS(str(WEIGHTS), device=self.device or "cuda:0", text_normalization=False)
        self.sr = int(self.m.sample_rate)

    def _prepare_voice(self, ref_path, ref_text, desc):
        return {"ref": ref_path, "ref_text": ref_text, "desc": desc}

    def _synth(self, text, cond, params, seed):
        import torch
        torch.manual_seed(int(seed))
        cond = cond or {}
        lang = LANG_NAMES.get(str(params.get("language") or "en").lower().split("-")[0], "English")
        cfg = float(params.get("cfg", 2.0))
        if cond.get("ref"):
            wav = self.m.synthesize(task="TTS", language_id=lang, text=text, prompt_wav_path=cond["ref"],
                                    prompt_text=cond.get("ref_text") or None, use_spk_emb=True, cfg=cfg)
        else:
            style = params.get("instruct") or cond.get("desc") or "A clear, warm, natural voice."
            wav = self.m.synthesize(task="VOICE_DESIGN", text=text, controls={"style": style}, use_zero_spk_emb=True, cfg=cfg)
        return wav.squeeze(0).float().cpu().numpy()
