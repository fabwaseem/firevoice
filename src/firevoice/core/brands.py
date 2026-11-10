"""FireVoice names for the engines, like the voice library's names: one unique name per engine, chosen from what it is
good at. The model behind each name stays visible (`model`, its licence and its id), since the licences ask for credit.

Three measured axes go with every name:
  quality  Studio | Pro | Standard   listening, voice match and DNSMOS on the same passage and voice, sample rate,
                                     and what the engine can do (2026-11-10, RTX 5080)
  size     XS | S | M | L | XL       GPU memory one worker needs
  speed    Instant | Fast | Real-time | Slow   real-time factor of a warm single take (seconds of work per second of
                                     speech; below 1 is faster than playback)

The names follow the heat: the biggest, best engines carry the hottest names (Inferno, Magma), quick small ones the
quickest flames (Spark, Flash, Flicker), slow ones the slow burns (Smoulder, Candle, Hearth).
Any API or CLI field that takes an engine id also takes its name, in any case.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Brand:
    name: str
    quality: str            # Studio | Pro | Standard (tools: "-")
    tagline: str            # what it is best at, in a few words
    params: str = ""        # model size as published ("2B", "82M"), when known
    rtf: Optional[float] = None   # measured real-time factor (warm, one take); None: not a speech engine


BRANDS: dict[str, Brand] = {
    # speech: studio
    "voxcpm2": Brand("Inferno", "Studio", "the flagship: most natural, 48 kHz, cloning and voice design in 30 languages", "2B", 0.41),
    "moss": Brand("Magma", "Studio", "heavyweight cloning with the cleanest sound, needs a big GPU", "", 0.71),
    "indextts25": Brand("Firestorm", "Studio", "emotion you can steer, with exact timing", "", 0.55),
    "breeze": Brand("Smoulder", "Studio", "top of the open listening tests, but a slow burn (research use)", "3B", 5.98),
    # speech: pro
    "chatterbox": Brand("Torch", "Pro", "steady, faithful cloning with expressive control", "500M", 0.46),
    "omnivoice": Brand("Flare", "Pro", "bright, fast cloning and voice design", "0.6B", 0.18),
    "indextts2": Brand("Firebrand", "Pro", "emotional delivery from a vector or a reference clip", "", 0.95),
    "dots": Brand("Hearth", "Pro", "warm 48 kHz cloning, unhurried", "2B", 1.21),
    "qwen3-tts": Brand("Beacon", "Pro", "strong 3-second cloning in 10 languages", "1.7B", 1.74),
    "qwen3-tts-design": Brand("Forge", "Pro", "forges new voices from a written description", "1.7B", 2.34),
    "maya1": Brand("Phoenix", "Pro", "expressive voices born from a description, with emotion tags", "3B", 1.75),
    "ming": Brand("Candle", "Pro", "small and careful: cloning and voice design", "0.5B", 1.35),
    # speech: standard
    "chatterbox-turbo": Brand("Flash", "Standard", "quick cloning that ships with the backend", "350M", 0.20),
    "f5": Brand("Flicker", "Standard", "fast flow-matching cloning", "0.3B", 0.29),
    "kokoro": Brand("Spark", "Standard", "tiny and instant, preset voices, runs on a CPU", "82M", 0.04),
    # other tasks
    "chatterbox-vc": Brand("Mirage", "-", "turns one voice into another, keeping the delivery"),
    "audioldm2": Brand("Crackle", "-", "sound effects and ambience from a description"),
    "musicgen": Brand("Bonfire", "-", "music beds and tracks up to 3 minutes"),
    "separator": Brand("Crucible", "-", "separates a voice from music, noise or room echo"),
}


def size_label(vram_gb: Optional[float]) -> str:
    if not vram_gb:
        return "-"
    for top, label in ((1.5, "XS"), (4.5, "S"), (6.5, "M"), (8.5, "L")):
        if vram_gb <= top:
            return label
    return "XL"


def speed_label(rtf: Optional[float]) -> str:
    if rtf is None:
        return "-"
    if rtf < 0.1:
        return "Instant"
    if rtf < 0.35:
        return "Fast"
    if rtf < 1.0:
        return "Real-time"
    return "Slow"


def describe(engine: str, vram_gb: Optional[float] = None) -> dict:
    """The brand fields an engine description carries (empty name for engines without one)."""
    b = BRANDS.get(engine)
    if b is None:
        return {"brand": None, "tagline": "", "tier": None}
    return {"brand": b.name, "tagline": b.tagline,
            "tier": {"quality": b.quality, "size": size_label(vram_gb), "speed": speed_label(b.rtf), "params": b.params or None,
                     "rtf": b.rtf, "vram_gb": vram_gb}}


def engine_for(name: str) -> Optional[str]:
    """The engine id behind a FireVoice name ("Inferno", "inferno" -> "voxcpm2"), or None."""
    n = (name or "").strip().lower()
    return next((e for e, b in BRANDS.items() if b.name.lower() == n), None)


def name_of(engine: str) -> str:
    """The FireVoice name of an engine id, or the id itself."""
    b = BRANDS.get(engine)
    return b.name if b else engine
