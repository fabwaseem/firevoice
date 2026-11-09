"""OmniVoice (k2-fsa, 0.6B, CC-BY-NC weights, 24 kHz). venv: .envs/omnivoice"""
from __future__ import annotations

from pathlib import Path

from .base import Adapter

WEIGHTS = Path(__file__).resolve().parents[4] / ".envs" / "weights" / "omnivoice"


class OmniVoiceAdapter(Adapter):
    name = "omnivoice"
    sr = 24000
    needs_reference = False
    needs_ref_text = True
    supports_design = True
    supports_instruct = True
    license = "CC-BY-NC-4.0"
    commercial = False
    vram_gb = 3.0

    def _load(self) -> None:
        import torch
        from omnivoice import OmniVoice
        src = str(WEIGHTS) if (WEIGHTS / "config.json").exists() else "k2-fsa/OmniVoice"
        self.m = OmniVoice.from_pretrained(src, device_map=self.device, dtype=torch.float16)

    def _prepare_voice(self, ref_path, ref_text, desc):
        if ref_path:
            try:
                return {"prompt": self.m.create_voice_clone_prompt(ref_audio=ref_path, ref_text=ref_text), "ref": ref_path, "ref_text": ref_text}
            except Exception:
                return {"ref": ref_path, "ref_text": ref_text}
        return {"desc": desc or "A clear natural adult voice."}

    def _synth(self, text, cond, params, seed):
        cond = cond or {}
        kw = dict(text=text, language=params.get("language", "English"))
        if params.get("speed"):
            kw["speed"] = float(params["speed"])
        if cond.get("prompt") is not None:
            kw["voice_clone_prompt"] = cond["prompt"]
        elif cond.get("ref"):
            kw.update(ref_audio=cond["ref"], ref_text=cond.get("ref_text"))
        else:
            kw["instruct"] = " ".join(x for x in [cond.get("desc"), params.get("instruct")] if x)
        return self.m.generate(**kw)[0]
