"""MOSS-TTS Local-Transformer v1.5 (OpenMOSS, Apache-2.0, 48 kHz). venv: <engines>/moss. Model code comes with the weights
(transformers trust_remote_code, pinned revision), from <weights>/moss-tts-local-v1.5, and its audio codec from
<weights>/moss-audio-tokenizer-v2.

About 5B parameters plus a 2B codec: about 14 GB of VRAM in bf16, so it wants the GPU to itself. Cloning from a clip,
31 languages (Hindi yes, Urdu no), long passages, duration control. Output is stereo, mixed down to mono.
params: temperature (audio sampling, default 1.7), top_p, top_k.
"""
from __future__ import annotations

from ...paths import weights
from .base import Adapter

WEIGHTS = weights("moss-tts-local-v1.5")
CODEC = weights("moss-audio-tokenizer-v2")
LANG_NAMES = {"en": "English", "zh": "Chinese", "hi": "Hindi", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian",
              "pt": "Portuguese", "ru": "Russian", "ja": "Japanese", "ko": "Korean", "ar": "Arabic", "fa": "Persian", "tr": "Turkish"}


class MossAdapter(Adapter):
    name = "moss"
    sr = 48000
    needs_reference = True
    license = "Apache-2.0"
    commercial = True
    vram_gb = 14.0

    def _load(self) -> None:
        import torch
        from transformers import AutoModel, AutoProcessor
        try:
            torch.backends.cuda.enable_cudnn_sdp(False)
        except Exception:
            pass
        dev = self.device or "cuda"
        self.dev = dev
        self.proc = AutoProcessor.from_pretrained(str(WEIGHTS), trust_remote_code=True, codec_path=str(CODEC))
        self.m = AutoModel.from_pretrained(str(WEIGHTS), trust_remote_code=True, attn_implementation="sdpa",
                                           torch_dtype=torch.bfloat16).to(dev).eval()
        if hasattr(self.proc, "audio_tokenizer") and self.proc.audio_tokenizer is not None:
            self.proc.audio_tokenizer = self.proc.audio_tokenizer.to(dev)
        self.sr = int(self.proc.model_config.sampling_rate)

    def _prepare_voice(self, ref_path, ref_text, desc):
        if not ref_path:
            raise ValueError("MOSS-TTS clones from a reference clip; this voice has none")
        return {"ref": ref_path}

    def _synth(self, text, cond, params, seed):
        import torch
        torch.manual_seed(int(seed))
        lang = LANG_NAMES.get(str(params.get("language") or "en").lower().split("-")[0], "English")
        msg = self.proc.build_user_message(text=text, reference=[cond["ref"]], language=lang)
        batch = self.proc([[msg]], mode="generation")
        with torch.inference_mode():
            out = self.m.generate(input_ids=batch["input_ids"].to(self.dev), attention_mask=batch["attention_mask"].to(self.dev),
                                  max_new_tokens=4096, do_sample=True, audio_temperature=float(params.get("temperature", 1.7)),
                                  audio_top_p=float(params.get("top_p", 0.8)), audio_top_k=int(params.get("top_k", 25)),
                                  audio_repetition_penalty=1.0)
        audio = next(iter(self.proc.decode(out))).audio_codes_list[0]
        a = audio.float().cpu().numpy()
        return a.mean(axis=0) if a.ndim == 2 else a
