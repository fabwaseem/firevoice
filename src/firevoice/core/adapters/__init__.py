"""Engine adapters. Each adapter is a small class that knows one model's Python API. Adapters are imported
*inside the worker process* (which runs in that engine's own venv), never in the supervisor, so the
supervisor needs only numpy.

Adapter contract (duck-typed, see base.py):
    name, sr, needs_reference, supports_tags, supports_design, license, vram_gb
    load() -> None
    prepare_voice(voice_id, ref_path, ref_text, desc) -> None      cache conditioning per voice_id
    synth(text, voice_id, params: dict, seed: int) -> np.ndarray    mono float32 at self.sr
"""
from __future__ import annotations

import importlib

ADAPTERS: dict[str, str] = {
    "null": "firevoice.core.adapters.null:NullAdapter",
    "chatterbox-turbo": "firevoice.core.adapters.chatterbox_turbo:ChatterboxTurboAdapter",
    "chatterbox": "firevoice.core.adapters.chatterbox_base:ChatterboxAdapter",
    "qwen3-tts": "firevoice.core.adapters.qwen3:Qwen3Adapter",
    "qwen3-tts-design": "firevoice.core.adapters.qwen3:Qwen3DesignAdapter",
    "voxcpm2": "firevoice.core.adapters.voxcpm2:VoxCPM2Adapter",
    "dots": "firevoice.core.adapters.dots:DotsAdapter",
    "indextts2": "firevoice.core.adapters.indextts2:IndexTTS2Adapter",
    "breeze": "firevoice.core.adapters.breeze:BreezeAdapter",
    "omnivoice": "firevoice.core.adapters.omnivoice:OmniVoiceAdapter",
    "f5": "firevoice.core.adapters.f5:F5Adapter",
    "kokoro": "firevoice.core.adapters.kokoro:KokoroAdapter",
    "maya1": "firevoice.core.adapters.maya1:Maya1Adapter",
    "chatterbox-vc": "firevoice.core.adapters.chatterbox_vc:ChatterboxVCAdapter",
    "indextts25": "firevoice.core.adapters.indextts25:IndexTTS25Adapter",
    "ming": "firevoice.core.adapters.ming:MingAdapter",
    "moss": "firevoice.core.adapters.moss:MossAdapter",
    "audioldm2": "firevoice.core.adapters.audioldm2:AudioLDM2Adapter",
    "musicgen": "firevoice.core.adapters.musicgen:MusicGenAdapter",
}


def load_adapter(name: str, **kw):
    spec = ADAPTERS.get(name)
    if not spec:
        raise ValueError(f"unknown engine adapter {name!r}; known: {', '.join(sorted(ADAPTERS))}")
    mod, cls = spec.split(":")
    return getattr(importlib.import_module(mod), cls)(**kw)
