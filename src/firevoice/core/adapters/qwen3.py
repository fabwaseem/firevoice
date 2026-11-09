"""Qwen3-TTS 12Hz 1.7B (Alibaba, Apache-2.0). venv: .envs/qwen

Base model   : zero-shot cloning from a 3+ s clip; the transcript (ICL mode) noticeably improves similarity
VoiceDesign  : the voice is a natural-language description ("deep, calm male narrator in his forties ...")
Both accept per-utterance sampling params (temperature, top_p, top_k, repetition_penalty).
"""
from __future__ import annotations

from pathlib import Path

from .base import Adapter

WEIGHTS = Path(__file__).resolve().parents[4] / ".envs" / "weights"


def _src(local: str, hub: str) -> str:
    p = WEIGHTS / local
    return str(p) if (p / "config.json").exists() else hub


class Qwen3Adapter(Adapter):
    name = "qwen3-tts"
    sr = 24000
    needs_reference = True
    needs_ref_text = True
    license = "Apache-2.0"
    commercial = True
    vram_gb = 5.0
    hub = ("qwen3-tts-1.7b-base", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")

    def _load(self) -> None:
        import torch
        from qwen_tts import Qwen3TTSModel
        self.m = Qwen3TTSModel.from_pretrained(_src(*self.hub), device_map=self.device, dtype=torch.bfloat16, attn_implementation="sdpa")

    def _prepare_voice(self, ref_path, ref_text, desc):
        if not ref_path:
            raise ValueError("qwen3-tts needs a reference clip (use qwen3-tts-design for description-only voices)")
        return self.m.create_voice_clone_prompt(ref_audio=ref_path, ref_text=ref_text or None, x_vector_only_mode=not ref_text)

    def _gen_kwargs(self, params: dict) -> dict:
        kw = {}
        for k in ("temperature", "top_p", "top_k", "repetition_penalty", "max_new_tokens"):
            if k in params:
                kw[k] = params[k]
        return kw

    def _synth(self, text, cond, params, seed):
        wavs, sr = self.m.generate_voice_clone(text=text, language=params.get("language", "English"), voice_clone_prompt=cond, **self._gen_kwargs(params))
        self.sr = int(sr)
        return wavs[0]


class Qwen3DesignAdapter(Qwen3Adapter):
    name = "qwen3-tts-design"
    needs_reference = False
    needs_ref_text = False
    supports_design = True
    supports_instruct = True
    hub = ("qwen3-tts-1.7b-voicedesign", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")

    def _prepare_voice(self, ref_path, ref_text, desc):
        return {"desc": desc or "A clear, natural adult voice."}

    def _synth(self, text, cond, params, seed):
        instruct = (cond or {}).get("desc", "")
        if params.get("instruct"):
            instruct = f"{instruct} {params['instruct']}".strip()
        wavs, sr = self.m.generate_voice_design(text=text, language=params.get("language", "English"), instruct=instruct, **self._gen_kwargs(params))
        self.sr = int(sr)
        return wavs[0]
