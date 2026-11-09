"""Static engine catalog: what each engine can do and which knobs it takes, known before any model is loaded.

The desktop app and the CLI read this to draw controls and validate requests: capability flags, languages,
the venv and weights it needs, and a typed schema for every engine-specific parameter (the names are exactly the
keys the adapter reads from `params`). Generic delivery controls (style, pace, instruct, seed, loudness...) live
on the request itself and apply to every engine.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

from .registry import ENVS


@dataclass
class Param:
    name: str
    type: str                       # float | int | bool | str | enum | vector
    default: Any = None
    min: Optional[float] = None
    max: Optional[float] = None
    step: Optional[float] = None
    choices: Optional[list] = None
    length: Optional[int] = None    # vector length
    labels: Optional[list] = None   # vector component names
    label: str = ""
    help: str = ""

    def coerce(self, v):
        """Validate and convert one value; raises ValueError with a readable message."""
        if v is None:
            return None
        t = self.type
        try:
            if t == "float":
                v = float(v)
            elif t == "int":
                v = int(float(v))
            elif t == "bool":
                v = v if isinstance(v, bool) else str(v).strip().lower() in ("1", "true", "yes", "on")
            elif t in ("str", "enum"):
                v = str(v)
            elif t == "vector":
                if isinstance(v, str):
                    v = [float(x) for x in v.replace(";", ",").split(",") if x.strip()]
                v = [float(x) for x in v]
        except (TypeError, ValueError):
            raise ValueError(f"parameter {self.name!r} expects {t}, got {v!r}")
        if t in ("float", "int"):
            if self.min is not None and v < self.min or self.max is not None and v > self.max:
                raise ValueError(f"parameter {self.name!r} must be between {self.min} and {self.max}, got {v}")
        if t == "enum" and self.choices and v not in self.choices:
            raise ValueError(f"parameter {self.name!r} must be one of {', '.join(map(str, self.choices))}, got {v!r}")
        if t == "vector":
            if self.length and len(v) != self.length:
                raise ValueError(f"parameter {self.name!r} needs {self.length} numbers, got {len(v)}")
            if self.min is not None and any(x < self.min for x in v) or self.max is not None and any(x > self.max for x in v):
                raise ValueError(f"parameter {self.name!r} values must be between {self.min} and {self.max}")
        return v


@dataclass
class EngineInfo:
    name: str
    title: str
    clone: bool = True              # speaks in the voice of a reference clip
    needs_reference: bool = True    # cannot speak without one (else: built-in / designed / preset voice)
    needs_transcript: bool = False  # cloning quality depends on the reference transcript
    design: bool = False            # voice from a text description
    instruct: bool = False          # free-text delivery instruction (style / emotion) per request
    tags: bool = False              # inline [laugh] [sigh] ...
    presets: list = field(default_factory=list)
    languages: list = field(default_factory=list)   # ISO codes; ["*"] = very many
    sample_rate: int = 24000
    venv: Optional[str] = None      # .envs/<venv>
    weights: Optional[str] = None   # .envs/weights/<weights>
    speed_rtf: Optional[float] = None   # measured real-time factor on an RTX 5080 (lower is faster)
    notes: str = ""
    params: list = field(default_factory=list)

    def param(self, name: str) -> Optional[Param]:
        return next((p for p in self.params if p.name == name), None)

    def status(self) -> dict:
        venv_ok = self.venv is None or (ENVS / self.venv).exists()
        w = ENVS / "weights" / self.weights if self.weights else None
        weights_ok = w is None or (w.exists() and any(w.glob("*")) and not any(w.rglob("*.incomplete")))
        problems = []
        if not venv_ok:
            problems.append(f"missing venv .envs/{self.venv}")
        if not weights_ok:
            problems.append(f"missing or incomplete weights .envs/weights/{self.weights}")
        return {"ready": venv_ok and weights_ok, "venv_ok": venv_ok, "weights_ok": weights_ok, "problems": problems}

    def to_dict(self) -> dict:
        d = asdict(self)
        d["params"] = [asdict(p) for p in self.params]
        return d


VOXCPM_LANGS = ["ar", "my", "zh", "da", "nl", "en", "fi", "fr", "de", "el", "he", "hi", "id", "it", "ja", "km", "ko", "lo", "ms", "no",
                "pl", "pt", "ru", "es", "sw", "sv", "tl", "th", "tr", "vi"]
QWEN_LANGS = ["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"]
QWEN_LANG_NAMES = ["Auto", "Chinese", "English", "Japanese", "Korean", "German", "French", "Russian", "Portuguese", "Spanish", "Italian"]
EMO_LABELS = ["happy", "angry", "sad", "afraid", "disgusted", "melancholic", "surprised", "calm"]
KOKORO_PRESETS = ["af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "am_michael", "am_adam", "am_fenrir", "am_puck",
                  "bf_emma", "bf_isabella", "bm_george", "bm_lewis"]

T_TEMP = Param("temperature", "float", 0.8, 0.05, 1.5, 0.05, label="Temperature", help="randomness of the delivery; lower = steadier")
T_TOPP = Param("top_p", "float", 0.95, 0.1, 1.0, 0.01, label="Top-p")


CATALOG: dict[str, EngineInfo] = {e.name: e for e in [
    EngineInfo("null", "Null (test)", clone=False, needs_reference=False, design=True, tags=True, languages=["*"], notes="silence, for tests"),
    EngineInfo("chatterbox-turbo", "Chatterbox Turbo 350M", tags=True, languages=["en"], speed_rtf=0.22,
               notes="fastest cloner; [laugh] [sigh] tags; PerTh watermark",
               params=[T_TEMP, T_TOPP, Param("top_k", "int", 1000, 1, 4000, 1, label="Top-k"),
                       Param("repetition_penalty", "float", 1.2, 1.0, 2.0, 0.05, label="Repetition penalty")]),
    EngineInfo("chatterbox", "Chatterbox 500M", needs_reference=False, languages=["en"],
               notes="built-in voice when no reference; exaggeration knob",
               params=[T_TEMP, Param("exaggeration", "float", 0.5, 0.25, 2.0, 0.05, label="Exaggeration", help="emotional intensity"),
                       Param("cfg", "float", 0.5, 0.0, 1.0, 0.05, label="CFG weight", help="lower = slower, more deliberate")]),
    EngineInfo("qwen3-tts", "Qwen3-TTS 1.7B Base", needs_transcript=True, languages=QWEN_LANGS, venv="qwen", weights="qwen3-tts-1.7b-base", speed_rtf=1.79,
               params=[Param("language", "enum", "English", choices=QWEN_LANG_NAMES, label="Language")]),
    EngineInfo("qwen3-tts-design", "Qwen3-TTS 1.7B VoiceDesign", clone=False, needs_reference=False, design=True, instruct=True, languages=QWEN_LANGS,
               venv="qwen", weights="qwen3-tts-1.7b-voicedesign",
               params=[Param("language", "enum", "English", choices=QWEN_LANG_NAMES, label="Language")]),
    EngineInfo("voxcpm2", "VoxCPM2 2B", needs_reference=False, design=True, instruct=True, languages=VOXCPM_LANGS, sample_rate=48000,
               venv="voxcpm", weights="voxcpm2", speed_rtf=0.36,
               notes="48 kHz; clone, ultimate clone, design and style instructions in 30 languages; compiled with triton when available",
               params=[Param("cfg_value", "float", 2.0, 1.0, 4.0, 0.1, label="Guidance", help="how strictly it follows the text and voice prompt"),
                       Param("inference_timesteps", "int", 10, 4, 32, 1, label="Diffusion steps", help="fewer = faster, more = cleaner"),
                       Param("ultimate", "bool", False, label="Ultimate clone", help="also feed the reference transcript and continue from the clip")]),
    EngineInfo("dots", "dots.tts SOAR 2B", languages=["en", "zh"], sample_rate=48000, venv="dots", weights="dots-tts-soar", speed_rtf=1.28,
               notes="48 kHz; very high speaker similarity",
               params=[Param("guidance_scale", "float", 1.2, 1.0, 4.0, 0.1, label="Guidance"), Param("num_steps", "int", 10, 4, 32, 1, label="Steps"),
                       Param("language", "enum", "en", choices=["en", "zh"], label="Language")]),
    EngineInfo("indextts2", "IndexTTS-2", instruct=True, languages=["en", "zh"], sample_rate=22050, venv="indextts", weights="indextts-2",
               notes="emotion independent of timbre: emotion vector, emotion text or emotion reference clip",
               params=[Param("emo_vector", "vector", None, 0.0, 1.0, length=8, labels=EMO_LABELS, label="Emotion mix"),
                       Param("emo_alpha", "float", 0.6, 0.0, 1.0, 0.05, label="Emotion strength"),
                       Param("emo_text", "str", None, label="Emotion text", help="describe the emotion in words"),
                       Param("emo_ref", "str", None, label="Emotion reference clip", help="path to a clip whose emotion to copy")]),
    EngineInfo("breeze", "Breeze TTS 2 3B", needs_reference=False, needs_transcript=True, design=True, instruct=True, languages=["en", "zh"],
               venv="breeze", weights="breeze-tts-2", notes="voice direction; non-commercial weights",
               params=[Param("cfg_scale", "float", None, 1.0, 8.0, 0.5, label="Instruction strength", help="default 4 with an instruction, 1 without")]),
    EngineInfo("omnivoice", "OmniVoice 0.6B", needs_reference=False, design=True, instruct=True, languages=["*"], venv="omnivoice", weights="omnivoice",
               speed_rtf=0.10, notes="600+ languages; fast; non-commercial weights",
               params=[Param("language", "str", "English", label="Language name"), Param("speed", "float", None, 0.5, 2.0, 0.05, label="Speed")]),
    EngineInfo("f5", "F5-TTS v1", languages=["en", "zh"], venv="f5", speed_rtf=0.19, notes="flow matching; non-commercial weights",
               params=[Param("cfg_strength", "float", 2.0, 0.5, 5.0, 0.1, label="Guidance"), Param("nfe_step", "int", 32, 8, 64, 1, label="Steps"),
                       Param("speed", "float", 1.0, 0.5, 2.0, 0.05, label="Speed")]),
    EngineInfo("kokoro", "Kokoro 82M", clone=False, needs_reference=False, presets=KOKORO_PRESETS, languages=["en"], venv="kokoro", speed_rtf=0.01,
               notes="preset voices only (use voice 'design:<preset name>'); fastest",
               params=[Param("speed", "float", 1.0, 0.5, 2.0, 0.05, label="Speed")]),
    EngineInfo("maya1", "Maya1 3B", clone=False, needs_reference=False, design=True, tags=True, languages=["en"], venv="maya1", weights="maya1", speed_rtf=2.03,
               notes="voice from a description; 20 emotion tags",
               params=[Param("temperature", "float", 0.4, 0.05, 1.5, 0.05, label="Temperature"), T_TOPP,
                       Param("repetition_penalty", "float", 1.1, 1.0, 2.0, 0.05, label="Repetition penalty"),
                       Param("max_new_tokens", "int", 2048, 256, 4096, 64, label="Max tokens")]),
]}


def info(name: str) -> EngineInfo:
    from .registry import get_engine
    spec = get_engine(name)
    return CATALOG.get(spec.name) or EngineInfo(spec.name, spec.name, notes=spec.description, sample_rate=spec.sr)


def validate_params(engine: str, params: Optional[dict]) -> tuple[dict, list[str]]:
    """Coerce engine-specific params against the schema. Unknown names are passed through (an engine registered in
    ~/.firevoice/engines.json may take more) but reported as warnings."""
    e = info(engine)
    out, warn = {}, []
    for k, v in (params or {}).items():
        p = e.param(k)
        if p is None:
            warn.append(f"engine {e.name} has no documented parameter {k!r}; passed through as-is")
            out[k] = v
            continue
        v = p.coerce(v)
        if v is not None:
            out[k] = v
    return out, warn


def engine_dir(name: str) -> Path:
    return ENVS / (info(name).venv or "")
