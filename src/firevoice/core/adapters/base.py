from __future__ import annotations

import re
from typing import Optional

import numpy as np

TAG_RE = re.compile(r"\[(laugh|chuckle|sigh|gasp|cough|clear throat|sniff|groan|giggle|hmm)\]", re.I)


def strip_tags(text: str) -> str:
    return re.sub(r"\s{2,}", " ", TAG_RE.sub(" ", text)).strip()


def seed_torch(seed: int) -> None:
    import torch
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def to_mono_f32(a) -> np.ndarray:
    try:
        import torch
        if isinstance(a, torch.Tensor):
            a = a.detach().float().cpu().numpy()
    except Exception:
        pass
    a = np.asarray(a, dtype=np.float32)
    if a.ndim > 1:
        a = a.squeeze()
        if a.ndim > 1:
            a = a.mean(axis=0) if a.shape[0] < a.shape[1] else a.mean(axis=1)
    return np.ascontiguousarray(a)


def _detach_all(obj, _depth: int = 0):
    """Detach every tensor reachable through dicts/lists/tuples/simple objects (in place where possible)."""
    try:
        import torch
    except Exception:
        return obj
    if _depth > 4 or obj is None:
        return obj
    if torch.is_tensor(obj):
        return obj.detach()
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            obj[k] = _detach_all(v, _depth + 1)
        return obj
    if isinstance(obj, list):
        for i, v in enumerate(obj):
            obj[i] = _detach_all(v, _depth + 1)
        return obj
    if isinstance(obj, tuple):
        return tuple(_detach_all(v, _depth + 1) for v in obj)
    d = getattr(obj, "__dict__", None)
    if isinstance(d, dict):
        for k, v in list(d.items()):
            try:
                setattr(obj, k, _detach_all(v, _depth + 1))
            except Exception:
                pass
    return obj


class Adapter:
    """Base class with the shared bookkeeping. Subclasses set the class attributes and implement
    `_load`, `_prepare_voice`, `_synth`."""

    name = "base"
    sr = 24000
    needs_reference = True      # cannot speak without a reference clip
    needs_ref_text = False      # cloning quality depends on the transcript of the reference
    supports_tags = False       # inline [laugh] etc.
    supports_design = False     # voice from a text description instead of a clip
    supports_instruct = False   # free-text delivery instruction per utterance
    supports_streaming = False  # can hand out audio while one generation is still running (synth_stream)
    spell_acronyms = True       # the text pass writes "GPU" as "G P U" for models that would read it as a word
    passage_chars = 0           # >0: whole sentences are packed into one generation up to this many characters (one
                                # delivery for the passage, no seams); 0: one generation per sentence
    license = "unknown"
    commercial = False
    vram_gb = 4.0

    def __init__(self, device: Optional[str] = None, **kw):
        self.device = device
        self.loaded = False
        self.voices: dict[str, object] = {}
        self.extra = kw

    # -- lifecycle ---------------------------------------------------------
    def load(self) -> None:
        if self.loaded:
            return
        try:
            import torch
            if self.device is None:
                self.device = "cuda" if torch.cuda.is_available() else "cpu"
            if self.device.startswith("cuda"):
                torch.backends.cuda.matmul.allow_tf32 = True
                torch.backends.cudnn.allow_tf32 = True
                # never cudnn.benchmark here: every take has a new length, so autotuning would rerun per take
                torch.backends.cudnn.benchmark = False
        except Exception:
            self.device = self.device or "cpu"
        self._load()
        self.loaded = True

    def warmup(self) -> None:
        try:
            if self.needs_reference and not self.voices:
                return
            vid = next(iter(self.voices), None)
            self.synth("Warm up.", vid, {}, 1)
        except Exception:
            pass

    def prepare_voice(self, voice_id: str, ref_path: Optional[str], ref_text: Optional[str], desc: Optional[str]) -> None:
        """Voice conditioning is cached per voice_id for the life of the worker, so it must be computed without
        autograd: a conditioning tensor that still references its graph keeps ~0.3 GB of activations alive per
        voice (22 voices = 6 GB of leaked VRAM, and the driver starts paging)."""
        self.load()
        if voice_id in self.voices:
            return
        try:
            import torch
            ctx = torch.inference_mode()
        except Exception:
            import contextlib
            ctx = contextlib.nullcontext()
        with ctx:
            cond = self._prepare_voice(ref_path, ref_text, desc)
        self.voices[voice_id] = _detach_all(cond)

    def synth(self, text: str, voice_id: Optional[str], params: dict, seed: int) -> np.ndarray:
        self.load()
        if not self.supports_tags:
            text = strip_tags(text)
        try:
            seed_torch(seed)
        except Exception:
            pass
        cond = self.voices.get(voice_id) if voice_id else None
        if cond is None and self.needs_reference:
            raise ValueError(f"voice {voice_id!r} not prepared on this worker")
        return to_mono_f32(self._synth(text, cond, params or {}, seed))

    def synth_stream(self, text: str, voice_id: Optional[str], params: dict, seed: int):
        """Yield mono float32 pieces of one generation as they are decoded. Engines without real streaming yield the
        whole take once."""
        if not self.supports_streaming:
            yield self.synth(text, voice_id, params, seed)
            return
        self.load()
        if not self.supports_tags:
            text = strip_tags(text)
        try:
            seed_torch(seed)
        except Exception:
            pass
        cond = self.voices.get(voice_id) if voice_id else None
        if cond is None and self.needs_reference:
            raise ValueError(f"voice {voice_id!r} not prepared on this worker")
        for piece in self._synth_stream(text, cond, params or {}, seed):
            piece = to_mono_f32(piece)
            if len(piece):
                yield piece

    def _synth_stream(self, text: str, cond, params: dict, seed: int):
        raise NotImplementedError

    def stats(self) -> dict:
        d = {"name": self.name, "sr": self.sr, "voices": list(self.voices), "device": self.device}
        try:
            import torch
            if torch.cuda.is_available():
                d["vram_gb"] = round(torch.cuda.memory_allocated() / 1e9, 2)
                d["vram_reserved_gb"] = round(torch.cuda.memory_reserved() / 1e9, 2)
                d["vram_peak_gb"] = round(torch.cuda.max_memory_allocated() / 1e9, 2)
        except Exception:
            pass
        return d

    # -- to implement --------------------------------------------------------
    def _load(self) -> None:
        raise NotImplementedError

    def _prepare_voice(self, ref_path, ref_text, desc):
        return {"ref": ref_path, "ref_text": ref_text, "desc": desc}

    def _synth(self, text: str, cond, params: dict, seed: int):
        raise NotImplementedError
