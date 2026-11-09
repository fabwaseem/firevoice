"""Breeze TTS 2 (BreezeBlue, 3B, research/non-commercial weights, 24 kHz). venv: .envs/breeze

Keeps the model resident by driving the upstream repo's own runtime modules (`breeze_infer.runtime`,
`breeze_infer.templates`, `models.fast_streaming`) exactly the way its infer.py does, so one worker loads the
7.7 GB model once and then renders every utterance in-process. If those imports fail (repo moved, API changed)
the adapter falls back to shelling out to infer.py per utterance, which still works but reloads the model each call.

Modes (chosen per call from what the caller provides):
  clone      ref + transcript, no instruction                      (template ref_clone_tata)
  direction  ref + transcript + instruction, cfg ~4                (template ref_edit_tata)
  design     instruction only, cfg ~4                              (template tts_instruction)
  plain      text only                                             (template tts_plain)

Extra kwargs: fast=True enables the repo's CUDA-graph fast path (needs ~14 GB VRAM, long warm-up);
attn="sdpa" overrides the attention implementation (upstream default is eager).
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

import numpy as np

from ...paths import engines_dir, weights
from .base import Adapter

REPO = engines_dir() / "breeze-repo"
WEIGHTS = weights("breeze-tts-2")
DEFAULT_INSTRUCT_CFG = 4.0   # README: "Use --cfg-scale 4 to strengthen instruction-following"
MAX_NEW_TOKENS = 1500
MAX_SEQ_LEN = 2048
REPETITION_PENALTY = 1.1


class BreezeRuntime:
    """Resident Breeze model: load once, synthesize many. Mirrors infer.py main()."""

    def __init__(self, weights: Path | str = WEIGHTS, repo: Path | str = REPO, *, device: Optional[str] = None,
                 fast: bool = False, attn: str = "eager"):
        self.weights = Path(weights)
        self.repo = Path(repo)
        if str(self.repo) not in sys.path:
            sys.path.insert(0, str(self.repo))
        from breeze_infer.runtime import load_runtime, resolve_device, update_generation_config_for_breeze  # type: ignore
        from breeze_infer.templates import get_template, prepare_inputs, select_template_name  # type: ignore
        from models.fast_streaming import FastBreezeStreamingRuntime, FastStreamingConfig  # type: ignore

        self._get_template, self._prepare_inputs, self._select = get_template, prepare_inputs, select_template_name
        dev = device or resolve_device()
        self.tokenizer, self.model, self.audio_tokenizer = load_runtime(self.weights, device=dev, attn_implementation=attn)
        update_generation_config_for_breeze(self.model)
        cfg = FastStreamingConfig(max_new_tokens=MAX_NEW_TOKENS, max_seq_len=MAX_SEQ_LEN,
                                  fast_all=True if fast else None, repetition_penalty=REPETITION_PENALTY)
        self.rt = FastBreezeStreamingRuntime(self.model, self.audio_tokenizer, cfg, tokenizer=self.tokenizer)
        if self.rt.fast_enabled:
            from dataclasses import replace
            from models.warmup_profile import load_warmup_profile  # type: ignore
            profile = load_warmup_profile(self.repo / "configs" / "fast.json")
            profile = replace(profile, codec_chunk_frames=self.rt.codec_chunk_frames)
            self.rt.warmup_from_profile(profile)
        self.sr = int(self.rt.sample_rate)
        self._n = 0

    def synth(self, text: str, *, ref: Optional[str] = None, ref_text: Optional[str] = None,
              instruction: Optional[str] = None, cfg_scale: Optional[float] = None, seed: int = 42) -> np.ndarray:
        from breeze_infer.runtime import set_all_seeds  # type: ignore
        instruction = (instruction or "").strip() or None
        if bool(ref) != bool(ref_text and ref_text.strip()):
            raise ValueError("Breeze cloning needs both the reference clip and its transcript")
        req = {"id": f"fv-{self._n}", "text": text, "speaker": "S0"}
        self._n += 1
        if instruction:
            req["instruction"] = instruction
        if ref:
            req["ref_audio_path"] = str(ref)
            req["ref_text"] = ref_text.strip()
        if cfg_scale is None:
            cfg_scale = DEFAULT_INSTRUCT_CFG if instruction else 1.0
        template = self._get_template(self._select(req))
        set_all_seeds(int(seed))
        inputs = self._prepare_inputs(self.tokenizer, self.audio_tokenizer, self.model, [req], template,
                                      guidance_scale=float(cfg_scale), guidance_scale_ref=None, guidance_scale_ins=None)
        chunks = [np.asarray(c.audio, dtype=np.float32).reshape(-1)
                  for c in self.rt.iter_audio_chunks(inputs, request_id=req["id"], seed=int(seed))]
        return np.concatenate(chunks) if chunks else np.zeros(0, np.float32)


class _CliRuntime:
    """Fallback: one infer.py process per utterance (reloads the model every call)."""

    def __init__(self, weights: Path = WEIGHTS, repo: Path = REPO):
        self.weights, self.repo, self.sr = weights, repo, 24000
        self.tmp = Path(tempfile.mkdtemp(prefix="breeze-"))

    def synth(self, text, *, ref=None, ref_text=None, instruction=None, cfg_scale=None, seed=42):
        import soundfile as sf
        out = self.tmp / f"{seed}_{abs(hash(text)) % 10**8}.wav"
        cmd = [sys.executable, "-X", "utf8", "infer.py", str(self.weights), "--text", text, "--output", str(out), "--seed", str(seed)]
        if ref:
            cmd += ["--ref-audio", str(ref), "--ref-text", ref_text or ""]
        if instruction:
            cmd += ["--instruction", instruction, "--cfg-scale", str(cfg_scale or DEFAULT_INSTRUCT_CFG)]
        elif cfg_scale:
            cmd += ["--cfg-scale", str(cfg_scale)]
        p = subprocess.run(cmd, cwd=str(self.repo), capture_output=True, text=True, encoding="utf-8", errors="replace")
        if p.returncode != 0 or not out.exists():
            raise RuntimeError(f"breeze infer.py failed: {p.stderr[-600:]}")
        wav, sr = sf.read(str(out), dtype="float32")
        self.sr = int(sr)
        out.unlink(missing_ok=True)
        return wav


def make_runtime(**kw):
    """Resident runtime if the repo imports cleanly, else the CLI fallback. Returns (runtime, resident: bool)."""
    if os.environ.get("FIREVOICE_BREEZE_CLI"):
        return _CliRuntime(), False
    try:
        return BreezeRuntime(**kw), True
    except Exception as e:  # noqa: BLE001
        print(f"[breeze] resident runtime unavailable ({type(e).__name__}: {str(e)[:200]}); using infer.py per call", file=sys.stderr)
        return _CliRuntime(), False


class BreezeAdapter(Adapter):
    name = "breeze"
    sr = 24000
    needs_reference = False
    needs_ref_text = True
    supports_design = True
    supports_instruct = True
    license = "BreezeBlue Research and Non-Commercial License"
    commercial = False
    vram_gb = 8.0

    def _load(self) -> None:
        kw = {}
        if self.device:
            kw["device"] = self.device
        if self.extra.get("fast"):
            kw["fast"] = True
        if self.extra.get("attn"):
            kw["attn"] = str(self.extra["attn"])
        self.rt, self.resident = make_runtime(**kw)
        self.sr = int(self.rt.sr)

    def _prepare_voice(self, ref_path, ref_text, desc):
        return {"ref": ref_path, "ref_text": ref_text, "desc": desc}

    def _synth(self, text, cond, params, seed):
        cond = cond or {}
        # with a reference the description is redundant (the clip carries the identity); without one it IS the voice
        parts = [None if cond.get("ref") else cond.get("desc"), params.get("instruct")]
        instruction = " ".join(x for x in parts if x) or None
        cfg = params.get("cfg_scale")
        wav = self.rt.synth(text, ref=cond.get("ref"), ref_text=cond.get("ref_text"), instruction=instruction,
                            cfg_scale=float(cfg) if cfg is not None else None, seed=seed)
        self.sr = int(self.rt.sr)
        return wav
