"""VoxCPM2 (OpenBMB, Apache-2.0, 48 kHz). venv: .envs/voxcpm

Speed: compiled with torch.compile when triton is importable (see _load).

Voice modes
  ultimate (default when the voice has a transcript): reference + exact transcript -> continuation cloning. Every
                    sentence continues from the same clip, so a long script keeps one speaker and one delivery.
                    Measured on six voices: sentence-to-sentence speaker similarity 0.895 vs 0.836, pitch jump between
                    sentences 28 Hz vs 57 Hz. A style instruction cannot ride along here (the model reads it aloud).
  clone           : reference_wav_path only, with the style instruction in parentheses before the text. Each sentence
                    re-imagines the speaker from the clip, so delivery can drift between sentences. Used when the
                    voice has no transcript, or when the request turns `ultimate` off (an explicit `instruct` does).
  design          : "(description) text" with no reference
"""
from __future__ import annotations

from pathlib import Path

from .base import Adapter

WEIGHTS = Path(__file__).resolve().parents[4] / ".envs" / "weights" / "voxcpm2"


class VoxCPM2Adapter(Adapter):
    name = "voxcpm2"
    sr = 48000
    needs_reference = False
    supports_design = True
    supports_instruct = True
    license = "Apache-2.0"
    commercial = True
    vram_gb = 8.0
    # Each generation re-imagines the delivery a little, so a script split per sentence changes tone at every seam.
    # Measured on 2- and 5-sentence scripts: one generation per passage cuts the pitch jump between sentences from
    # 20-25 Hz to 5-7 Hz with no extra word errors up to ~310 characters.
    passage_chars = 360
    # VoxCPM2 reads "GPU" and "API" as letters on its own; spaced letters ("G P U") make it stop after each one
    spell_acronyms = False
    # generate_streaming decodes audio step by step: the first sound is ready long before the passage is finished
    supports_streaming = True

    def _load(self) -> None:
        from voxcpm import VoxCPM
        src = str(WEIGHTS) if (WEIGHTS / "config.json").exists() or any(WEIGHTS.glob("*.safetensors")) else "openbmb/VoxCPM2"
        # torch.compile (needs triton; on Windows the triton-windows wheel matching torch) makes generation ~3x faster
        # (RTF 1.05 -> 0.36 on an RTX 5080) for a one-time ~2 min warm-up per worker. Pass --kw optimize=0 to skip it.
        optimize = str(self.extra.get("optimize", "1")).lower() not in ("0", "false", "no")
        if optimize:
            try:
                import triton  # noqa: F401
            except ImportError:
                optimize = False
        self.m = VoxCPM.from_pretrained(src, load_denoiser=False, optimize=optimize)
        self.optimized = optimize
        self.sr = int(self.m.tts_model.sample_rate)

    def _prepare_voice(self, ref_path, ref_text, desc):
        return {"ref": ref_path, "ref_text": ref_text, "desc": desc}

    def _generate_kwargs(self, text, cond, params) -> dict:
        """The same voice modes as _synth, as keyword arguments for generate / generate_streaming."""
        cond = cond or {}
        cfg = float(params.get("cfg_value", 2.0))
        steps = int(params.get("inference_timesteps", 10))
        instruct = params.get("instruct")
        if cond.get("ref"):
            if params.get("ultimate", True) and cond.get("ref_text"):
                return dict(text=text, prompt_wav_path=cond["ref"], prompt_text=cond["ref_text"], reference_wav_path=cond["ref"], cfg_value=cfg, inference_timesteps=steps)
            return dict(text=f"({instruct}) {text}" if instruct else text, reference_wav_path=cond["ref"], cfg_value=cfg, inference_timesteps=steps)
        desc = " ".join(x for x in [cond.get("desc") or "A clear natural adult voice.", instruct] if x)
        return dict(text=f"({desc}) {text}", cfg_value=cfg, inference_timesteps=steps)

    def _synth_stream(self, text, cond, params, seed):
        yield from self.m.generate_streaming(**self._generate_kwargs(text, cond, params))

    def _synth(self, text, cond, params, seed):
        cond = cond or {}
        cfg = float(params.get("cfg_value", 2.0))
        steps = int(params.get("inference_timesteps", 10))
        instruct = params.get("instruct")
        if cond.get("ref"):
            if params.get("ultimate", True) and cond.get("ref_text"):
                return self.m.generate(text=text, prompt_wav_path=cond["ref"], prompt_text=cond["ref_text"], reference_wav_path=cond["ref"], cfg_value=cfg, inference_timesteps=steps)
            t = f"({instruct}) {text}" if instruct else text
            return self.m.generate(text=t, reference_wav_path=cond["ref"], cfg_value=cfg, inference_timesteps=steps)
        desc = " ".join(x for x in [cond.get("desc") or "A clear natural adult voice.", instruct] if x)
        return self.m.generate(text=f"({desc}) {text}", cfg_value=cfg, inference_timesteps=steps)
