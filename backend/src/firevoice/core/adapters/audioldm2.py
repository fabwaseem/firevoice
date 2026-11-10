"""AudioLDM 2 (CVSSP, weights CC-BY-NC-SA-4.0, 16 kHz): sound effects and ambience from a description.
venv: <engines>/sfx (diffusers). Not speech: the prompt describes the sound ("rain on a tin roof, distant thunder").

params: duration (s, 1-30), steps (diffusion steps, 25-200; more is cleaner and slower), negative (what to avoid).
"""
from __future__ import annotations

from ...paths import weights
from .base import Adapter

WEIGHTS = weights("audioldm2")


class AudioLDM2Adapter(Adapter):
    name = "audioldm2"
    sr = 16000
    needs_reference = False
    supports_design = False
    license = "CC-BY-NC-SA-4.0"
    commercial = False
    vram_gb = 4.0

    def _load(self) -> None:
        import torch
        from diffusers import AudioLDM2Pipeline
        src = str(WEIGHTS) if (WEIGHTS / "model_index.json").exists() else "cvssp/audioldm2"
        dev = self.device or "cuda"
        self.p = AudioLDM2Pipeline.from_pretrained(src, torch_dtype=torch.float16 if dev.startswith("cuda") else torch.float32).to(dev)
        self.p.set_progress_bar_config(disable=True)
        self.p.generate_language_model = self._language_model_steps
        self.dev = dev

    def _language_model_steps(self, inputs_embeds=None, max_new_tokens: int = 8, attention_mask=None, **_):
        """The pipeline's GPT-2 step, without the generation helpers newer transformers no longer give GPT2Model
        (diffusers calls _get_initial_cache_position and _update_model_kwargs_for_generation, both gone).
        Same result as the cached loop: the whole sequence again for each of the few new hidden states."""
        import torch
        lm = self.p.language_model
        n = max_new_tokens if max_new_tokens is not None else lm.config.max_new_tokens
        mask = attention_mask
        for _ in range(n):
            out = lm(inputs_embeds=inputs_embeds, attention_mask=mask, output_hidden_states=True, return_dict=True)
            inputs_embeds = torch.cat([inputs_embeds, out.hidden_states[-1][:, -1:, :]], dim=1)
            if mask is not None:
                mask = torch.cat([mask, mask.new_ones((mask.shape[0], 1))], dim=1)
        return inputs_embeds[:, -n:, :]

    def _prepare_voice(self, ref_path, ref_text, desc):
        return {}

    def _synth(self, text, cond, params, seed):
        import torch
        dur = float(min(30.0, max(1.0, params.get("duration", 5.0))))
        steps = int(min(200, max(25, params.get("steps", 100))))
        g = torch.Generator(self.dev).manual_seed(int(seed))
        out = self.p(text, negative_prompt=params.get("negative") or "low quality, distorted, speech, music",
                     num_inference_steps=steps, audio_length_in_s=dur, generator=g)
        return out.audios[0]
