"""Chatterbox Turbo (Resemble AI, MIT). Runs in the main venv.

Differences from the stock `generate()`:
  * conditioning is cached per voice_id (a dict of Conditionals) so one worker serves many voices without
    re-embedding the reference each time
  * the PerTh watermark is applied once per take here as upstream does; FireVoice never strips it
  * `max_new_tokens` is capped from the text length so a runaway babble take stops early instead of
    burning seconds (the model's own cap is 1000 tokens ~ 40 s)
"""
from __future__ import annotations

import numpy as np

from .base import Adapter


class ChatterboxTurboAdapter(Adapter):
    name = "chatterbox-turbo"
    sr = 24000
    needs_reference = True
    supports_tags = True
    license = "MIT"
    commercial = True
    vram_gb = 3.5

    def _load(self) -> None:
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        self.m = ChatterboxTurboTTS.from_pretrained(device=self.device)
        self.sr = int(self.m.sr)

    def _prepare_voice(self, ref_path, ref_text, desc):
        if not ref_path:
            raise ValueError("chatterbox-turbo needs a reference clip")
        self.m.prepare_conditionals(ref_path, norm_loudness=True)
        return self.m.conds

    def _synth(self, text, cond, params, seed):
        import torch
        from chatterbox.models.s3gen.const import S3GEN_SIL
        from chatterbox.tts_turbo import punc_norm
        self.m.conds = cond
        t = punc_norm(text)
        toks = self.m.tokenizer(t, return_tensors="pt", padding=True, truncation=True).input_ids.to(self.device)
        with torch.inference_mode():
            speech = self.m.t3.inference_turbo(
                t3_cond=cond.t3, text_tokens=toks,
                temperature=float(params.get("temperature", 0.8)), top_k=int(params.get("top_k", 1000)),
                top_p=float(params.get("top_p", 0.95)), repetition_penalty=float(params.get("repetition_penalty", 1.2)),
            )
            speech = speech[speech < 6561].to(self.device)
            speech = torch.cat([speech, torch.tensor([S3GEN_SIL] * 3, device=self.device).long()])
            wav, _ = self.m.s3gen.inference(speech_tokens=speech, ref_dict=cond.gen, n_cfm_timesteps=2)
        wav = wav.squeeze(0).detach().cpu().numpy()
        return self.m.watermarker.apply_watermark(wav, sample_rate=self.sr).astype(np.float32)
