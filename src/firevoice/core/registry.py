"""Engine registry: which python (venv) runs which adapter, with how many copies, under which license.

Built-in specs point at the venvs created under firevoice/.envs/<name>/ (one per heavy engine, so their
conflicting torch/transformers pins never fight). Override or add engines in ~/.firevoice/engines.json:

    {"my-engine": {"adapter": "qwen3-tts", "python": "D:/venvs/x/Scripts/python.exe", "default_workers": 1}}
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

PKG_ROOT = Path(__file__).resolve().parents[3]          # firevoice/
ENVS = PKG_ROOT / ".envs"


def _venv_python(name: str) -> str:
    cand = ENVS / name / "Scripts" / "python.exe" if os.name == "nt" else ENVS / name / "bin" / "python"
    return str(cand) if cand.exists() else sys.executable


@dataclass
class EngineSpec:
    name: str
    adapter: str
    python: str
    default_workers: int = 1
    license: str = "unknown"
    commercial: bool = False
    sr: int = 24000
    vram_gb: float = 4.0
    quality_tier: str = "unknown"          # filled from the bake-off
    description: str = ""
    adapter_kwargs: dict = field(default_factory=dict)
    extra_pythonpath: list = field(default_factory=list)
    env: dict = field(default_factory=dict)
    cwd: Optional[str] = None
    start_timeout: float = 120.0
    load_timeout: float = 900.0
    synth_timeout: float = 300.0

    def available(self) -> bool:
        return Path(self.python).exists()


def builtin_engines() -> dict[str, EngineSpec]:
    main_py = sys.executable
    specs = [
        EngineSpec("null", "null", main_py, default_workers=2, license="MIT", commercial=True, vram_gb=0, description="silence for tests"),
        EngineSpec("chatterbox-turbo", "chatterbox-turbo", main_py, default_workers=2, license="MIT", commercial=True, vram_gb=3.8,
                   description="Resemble Chatterbox Turbo 350M: fast, [laugh]/[sigh] tags, PerTh watermark"),
        EngineSpec("chatterbox", "chatterbox", main_py, default_workers=2, license="MIT", commercial=True, vram_gb=4.0,
                   description="Resemble Chatterbox 500M: exaggeration/CFG knobs, built-in voice"),
        EngineSpec("qwen3-tts", "qwen3-tts", _venv_python("qwen"), default_workers=2, license="Apache-2.0", commercial=True, vram_gb=5.0,
                   description="Qwen3-TTS 1.7B Base: 3 s zero-shot clone, 10 languages"),
        EngineSpec("qwen3-tts-design", "qwen3-tts-design", _venv_python("qwen"), default_workers=1, license="Apache-2.0", commercial=True, vram_gb=5.0,
                   description="Qwen3-TTS 1.7B VoiceDesign: voice from a text description"),
        EngineSpec("voxcpm2", "voxcpm2", _venv_python("voxcpm"), default_workers=1, license="Apache-2.0", commercial=True, vram_gb=7.4, sr=48000,
                   description="VoxCPM2 2B: 48 kHz, clone + voice design + style instructions"),
        EngineSpec("dots", "dots", _venv_python("dots"), default_workers=1, license="Apache-2.0", commercial=True, vram_gb=8.0, sr=48000,
                   description="dots.tts SOAR 2B: 48 kHz, highest speaker similarity"),
        EngineSpec("indextts2", "indextts2", _venv_python("indextts"), default_workers=1, license="bilibili non-commercial", commercial=False, vram_gb=6.0, sr=22050,
                   extra_pythonpath=[str(ENVS / "indextts-repo")], cwd=str(ENVS / "indextts-repo"),
                   description="IndexTTS-2: emotion vectors / emotion reference independent of timbre"),
        EngineSpec("breeze", "breeze", _venv_python("breeze"), default_workers=1, license="BreezeBlue non-commercial", commercial=False, vram_gb=8.0,
                   extra_pythonpath=[str(ENVS / "breeze-repo")], cwd=str(ENVS / "breeze-repo"),
                   description="Breeze TTS 2 3B: top open model on the speech arena, voice direction"),
        EngineSpec("omnivoice", "omnivoice", _venv_python("omnivoice"), default_workers=2, license="CC-BY-NC", commercial=False, vram_gb=3.0,
                   description="OmniVoice 0.6B: very fast cloning, voice design"),
        EngineSpec("f5", "f5", _venv_python("f5"), default_workers=2, license="CC-BY-NC", commercial=False, vram_gb=3.0,
                   description="F5-TTS v1: flow-matching cloning"),
        EngineSpec("kokoro", "kokoro", _venv_python("kokoro"), default_workers=2, license="Apache-2.0", commercial=True, vram_gb=1.0,
                   description="Kokoro 82M: preset voices, fastest, no cloning"),
        EngineSpec("maya1", "maya1", _venv_python("maya1"), default_workers=1, license="Apache-2.0", commercial=True, vram_gb=9.0,
                   description="Maya1 3B: voice from description, 20 emotion tags"),
    ]
    return {s.name: s for s in specs}


def user_engines() -> dict[str, EngineSpec]:
    f = Path(os.environ.get("FIREVOICE_HOME", Path.home() / ".firevoice")) / "engines.json"
    if not f.exists():
        return {}
    out = {}
    for name, d in json.loads(f.read_text(encoding="utf-8")).items():
        out[name] = EngineSpec(name=name, **{k: v for k, v in d.items() if k != "name"})
    return out


def all_engines() -> dict[str, EngineSpec]:
    d = builtin_engines()
    d.update(user_engines())
    return d


def get_engine(name: str) -> EngineSpec:
    d = all_engines()
    n = (name or "").lower().replace("_", "-")
    if n in d:
        return d[n]
    aliases = {"turbo": "chatterbox-turbo", "qwen": "qwen3-tts", "qwen3": "qwen3-tts", "voxcpm": "voxcpm2", "indextts": "indextts2", "dots-soar": "dots"}
    if n in aliases:
        return d[aliases[n]]
    raise ValueError(f"unknown engine {name!r}; known: {', '.join(sorted(d))}")


def describe() -> list[dict]:
    return [{**asdict(s), "available": s.available()} for s in all_engines().values()]
