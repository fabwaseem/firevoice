"""Delivery styles: engine-neutral descriptions of *how* a line should be read.

A style carries three kinds of knobs and every engine adapter uses the ones it understands:
  * timing      pace (tempo multiplier after synthesis), pause (multiplier on natural gaps), lead/tail
  * sampling    temperature / top_p / repetition_penalty (autoregressive engines), cfg (flow engines)
  * semantics   `instruct` (free-text delivery instruction for engines with instruction control:
                Qwen3-TTS design, VoxCPM2, OmniVoice, Breeze, IndexTTS-2 emotion text),
                `emo_vector` (IndexTTS-2), `exaggeration`/`cfg` (base Chatterbox), `desc` fragment appended
                to a designed voice's description, and `sample` (a paragraph that shows the style off).

Styles live in src/firevoice/styles/*.json (built in) and ~/.firevoice/styles/*.json (user); a user file
with the same name overrides the built-in one.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

BUILTIN_DIR = Path(__file__).resolve().parent / "styles"


@dataclass(frozen=True)
class Style:
    name: str = "neutral"
    title: str = ""
    description: str = ""
    pace: float = 1.0
    pause: float = 1.0
    temperature: float = 0.8
    top_p: float = 0.95
    repetition_penalty: float = 1.2
    cfg: float = 2.0                      # guidance for flow/CFM engines (VoxCPM2, dots, F5)
    exaggeration: float = 0.5             # base Chatterbox only
    cfg_weight: float = 0.5               # base Chatterbox only
    instruct: str = ""                    # delivery instruction for instruction-following engines
    desc: str = ""                        # appended to a designed voice's description
    emo_vector: tuple = ()                # IndexTTS-2: happy, angry, sad, afraid, disgusted, melancholic, surprised, calm
    emo_alpha: float = 0.7
    tags: tuple = ()                      # paralinguistic tags that suit the style (hint for writers)
    sample: str = ""                      # showcase paragraph for `firevoice samples`
    extra: dict = field(default_factory=dict)

    def params(self) -> dict:
        """Flat dict handed to engine adapters (they ignore unknown keys)."""
        d = {"temperature": self.temperature, "top_p": self.top_p, "repetition_penalty": self.repetition_penalty,
             "cfg_value": self.cfg, "cfg_strength": self.cfg, "guidance_scale": max(1.0, self.cfg / 2), "exaggeration": self.exaggeration, "cfg": self.cfg_weight,
             "pace": self.pace}
        if self.instruct:
            d["instruct"] = self.instruct
        if self.emo_vector:
            d["emo_vector"] = list(self.emo_vector)
            d["emo_alpha"] = self.emo_alpha
        d.update(self.extra)
        return d


_cache: Optional[dict[str, Style]] = None
STYLE_FIELDS = {f for f in Style.__dataclass_fields__ if f not in ("name", "extra")}


def _load_dir(d: Path, into: dict[str, Style]) -> None:
    if not d.exists():
        return
    for f in sorted(d.glob("*.json")):
        try:
            raw = json.loads(f.read_text(encoding="utf-8"))
            raw.setdefault("name", f.stem)
            if "emo_vector" in raw:
                raw["emo_vector"] = tuple(raw["emo_vector"])
            if "tags" in raw:
                raw["tags"] = tuple(raw["tags"])
            into[raw["name"]] = Style(**raw)
        except Exception as e:  # a broken style file must not take the whole library down
            import sys
            sys.stderr.write(f"[firevoice] ignoring style {f}: {e}\n")


def all_styles(refresh: bool = False) -> dict[str, Style]:
    global _cache
    if _cache is None or refresh:
        d: dict[str, Style] = {"neutral": Style()}
        _load_dir(BUILTIN_DIR, d)
        _load_dir(Path(os.environ.get("FIREVOICE_HOME", Path.home() / ".firevoice")) / "styles", d)
        _cache = d
    return _cache


def get_style(name: str) -> Style:
    s = all_styles()
    n = (name or "neutral").lower().strip()
    if n in s:
        return s[n]
    aliases = {"story": "storyteller", "narration": "storyteller", "scary": "horror", "hype": "excited", "explain": "explainer", "tutorial": "explainer",
               "chill": "calm", "meditation": "calm", "news": "newscaster", "doc": "documentary", "trailer": "trailer", "whisper": "asmr"}
    if n in aliases and aliases[n] in s:
        return s[aliases[n]]
    raise KeyError(f"unknown style {name!r}; available: {', '.join(sorted(s))}")


def style_dict(s: Style) -> dict:
    return asdict(s)


# Backwards compatibility with the 0.x API (dict of styles)
class _StylesProxy(dict):
    def __missing__(self, k):
        return get_style(k)


STYLES = _StylesProxy()
