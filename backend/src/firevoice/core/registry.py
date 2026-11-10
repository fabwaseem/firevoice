"""Engine registry: which python (venv) runs which adapter, with how many copies, under which license.

Built-in specs point at the venvs in the engines folder (paths.engines_dir(): <checkout>/.envs in a source checkout,
else FIREVOICE_HOME/engines; one venv per heavy engine, so their conflicting torch/transformers pins never fight). Override or add engines in ~/.firevoice/engines.json:

    {"my-engine": {"adapter": "qwen3-tts", "python": "D:/venvs/x/Scripts/python.exe", "default_workers": 1}}
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

from ..paths import engines_dir, home

ENVS = engines_dir()          # fixed for the life of the process; changing engines_dir needs a restart


def _venv_python(name: str) -> str:
    """The venv's interpreter, whether or not it exists yet: an engine installed while the server runs is picked up
    without a restart, and a missing one fails with a clear "not installed" instead of importing in the wrong venv."""
    return str(ENVS / name / "Scripts" / "python.exe" if os.name == "nt" else ENVS / name / "bin" / "python")


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
        EngineSpec("indextts25", "indextts25", _venv_python("indextts"), default_workers=1, license="bilibili non-commercial", commercial=False,
                   vram_gb=6.0, sr=22050, extra_pythonpath=[str(ENVS / "indextts-repo")], cwd=str(ENVS / "indextts-repo"),
                   description="IndexTTS-2.5: faster IndexTTS, native speech rate, zh/en/ja/es/ar"),
        EngineSpec("ming", "ming", _venv_python("ming"), default_workers=1, license="MIT", commercial=True, vram_gb=4.0, sr=44100,
                   extra_pythonpath=[str(ENVS / "ming-repo")], cwd=str(ENVS / "ming-repo"),
                   description="Ming-3.0-tts 0.5B: cloning, voice design, paralinguistic tags, 7 languages"),
        EngineSpec("moss", "moss", _venv_python("moss"), default_workers=1, license="Apache-2.0", commercial=True, vram_gb=14.0, sr=48000,
                   load_timeout=1800.0, description="MOSS-TTS Local-Transformer v1.5: 48 kHz cloning, 31 languages, long passages"),
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
        EngineSpec("separator", "separator", _venv_python("separator"), default_workers=1, license="MIT (models vary)", commercial=False,
                   vram_gb=3.0, sr=44100, synth_timeout=1800.0, description="voice/music separation, neural denoise and dereverb (UVR RoFormer)"),
        EngineSpec("audioldm2", "audioldm2", _venv_python("sfx"), default_workers=1, license="CC-BY-NC-SA-4.0", commercial=False, vram_gb=4.0,
                   sr=16000, description="AudioLDM 2: sound effects and ambience from a description"),
        EngineSpec("musicgen", "musicgen", _venv_python("sfx"), default_workers=1, license="CC-BY-NC-4.0", commercial=False, vram_gb=2.5,
                   synth_timeout=900.0,
                   sr=32000, description="MusicGen small: music beds from a description"),
        EngineSpec("chatterbox-vc", "chatterbox-vc", main_py, default_workers=1, license="MIT", commercial=True, vram_gb=3.0,
                   description="Chatterbox voice changer: speech to speech, keeps timing and delivery, swaps the voice"),
    ]
    if os.environ.get("FIREVOICE_TEST_ENGINES") == "1":
        # a silent engine for the test suite only: never offered by a normal server
        specs.insert(0, EngineSpec("null", "null", main_py, default_workers=2, license="MIT", commercial=True, vram_gb=0, description="silence for tests"))
    return {s.name: s for s in specs}


def user_engines() -> dict[str, EngineSpec]:
    """Extra engines from <home>/engines.json. A file or an entry that cannot be read is logged and skipped: one bad
    line never takes the built-in engines down with it."""
    f = home() / "engines.json"
    if not f.exists():
        return {}
    import logging
    log = logging.getLogger("firevoice")
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("expected an object of engine name -> settings")
    except Exception as e:
        log.warning("ignoring %s: %s", f, e)
        return {}
    out = {}
    for name, d in data.items():
        try:
            out[name] = EngineSpec(name=name, **{k: v for k, v in d.items() if k != "name"})
        except Exception as e:
            log.warning("ignoring engine %r in %s: %s", name, f, e)
    return out


_CACHE: dict = {"key": None, "engines": None}


def _cache_key() -> tuple:
    def mtime(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0
    h = home()
    return (str(h), mtime(h / "engines.json"), mtime(h / "settings.json"), os.environ.get("FIREVOICE_ENGINES_DIR"),
            os.environ.get("FIREVOICE_WEIGHTS_DIR"), os.environ.get("FIREVOICE_TEST_ENGINES"))


def all_engines() -> dict[str, EngineSpec]:
    """Every engine, built-in and user-defined. Rebuilt only when something it depends on changes (the data folder,
    engines.json, settings.json, the engine folder variables), not on every lookup."""
    key = _cache_key()
    if _CACHE["key"] != key or _CACHE["engines"] is None:
        d = builtin_engines()
        d.update(user_engines())
        _CACHE["key"], _CACHE["engines"] = key, d
    return dict(_CACHE["engines"])


def get_engine(name: str) -> EngineSpec:
    d = all_engines()
    n = (name or "").lower().replace("_", "-")
    if n in d:
        return d[n]
    aliases = {"turbo": "chatterbox-turbo", "qwen": "qwen3-tts", "qwen3": "qwen3-tts", "voxcpm": "voxcpm2", "indextts": "indextts2", "dots-soar": "dots"}
    if n in aliases:
        return d[aliases[n]]
    from .brands import engine_for
    b = engine_for(n)                      # a FireVoice name: "Inferno" -> voxcpm2
    if b in d:
        return d[b]
    from .brands import name_of
    raise ValueError(f"unknown engine {name!r}; available: {', '.join(sorted(name_of(e) for e in d))}")


def describe() -> list[dict]:
    return [{**asdict(s), "available": s.available()} for s in all_engines().values()]
