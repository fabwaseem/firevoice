"""A machine-readable mark on every piece of speech FireVoice makes (AudioSeal, Meta, MIT).

The mark is inaudible, survives MP3/AAC encoding, level changes and mixing, and carries 16 bits: 8 that say "made by
FireVoice" and 8 that say how (a render, a voice-changer conversion). `detect` finds it again, also in a clip cut out
of a longer file. This is what EU AI Act Article 50 asks of tools that generate synthetic audio (from 2026-08-02):
output marked in a machine-readable way, detectable as artificially generated.

Policy: FIREVOICE_WATERMARK, else `watermark` in settings.json, else "all". "off" turns it off; a request can also
pass `watermark: false`. Without the optional `audioseal` package nothing is marked, and the render says so.

The models are small (two ~15 MB networks) and run on the CPU, about 0.05 s per second of audio, so the GPU stays free
for the engines.
"""
from __future__ import annotations

import importlib.util
import os
import threading
from typing import Optional

import numpy as np

SR = 16000
TAG = [1, 1, 1, 1, 0, 1, 0, 1]          # 0xF5: "FireVoice"
KINDS = {"render": 1, "convert": 2}
WINDOW_S = 30.0                          # embed long audio in windows (bounded memory; the mark is local anyway)

_lock = threading.Lock()
_models: Optional[tuple] = None


def available() -> bool:
    return importlib.util.find_spec("audioseal") is not None


def policy() -> str:
    from . import paths
    v = (os.environ.get("FIREVOICE_WATERMARK") or paths.settings().get("watermark") or "all").lower()
    return v if v in ("all", "off") else "all"


def wanted(flag: Optional[bool]) -> bool:
    """Should this output be marked? A request's own flag wins over the policy."""
    return policy() == "all" if flag is None else bool(flag)


def _load():
    global _models
    with _lock:
        if _models is None:
            import torch
            from audioseal import AudioSeal
            gen = AudioSeal.load_generator("audioseal_wm_16bits").eval()
            det = AudioSeal.load_detector("audioseal_detector_16bits").eval()
            _models = (gen, det, torch)
        return _models


def _bits(kind: str) -> list[int]:
    k = KINDS.get(kind, 0)
    return TAG + [(k >> (7 - i)) & 1 for i in range(8)]


def _to16(a: np.ndarray, sr: int) -> np.ndarray:
    from . import audio as A
    return np.asarray(A.resample(np.asarray(a, dtype=np.float32), sr, SR) if sr != SR else a, dtype=np.float32)


def embed(audio: np.ndarray, sr: int, kind: str = "render") -> np.ndarray:
    """The audio with the mark added (same length and rate). Very short audio (< 0.25 s) is returned as is."""
    a = np.asarray(audio, dtype=np.float32)
    if len(a) < int(0.25 * sr):
        return a
    from . import audio as A
    from audioseal.libs.moshi.utils.compile import no_compile
    gen, _det, torch = _load()
    x = _to16(a, sr)
    msg = torch.tensor([_bits(kind)])
    step = int(WINDOW_S * SR)
    wm = np.zeros_like(x)
    with _lock, torch.inference_mode(), no_compile():
        for i in range(0, len(x), step):
            seg = x[i:i + step]
            if len(seg) < 400:          # AudioSeal needs a few frames
                continue
            out = gen.get_watermark(torch.from_numpy(seg.copy())[None, None], SR, message=msg)
            wm[i:i + len(seg)] = out[0, 0].numpy()
    if sr != SR:
        wm = A.resample(wm, SR, sr)
    if len(wm) < len(a):
        wm = np.pad(wm, (0, len(a) - len(wm)))
    return np.clip(a + wm[: len(a)], -1.0, 1.0).astype(np.float32)


def detect(audio: np.ndarray, sr: int) -> dict:
    """{"watermarked", "probability", "firevoice", "kind", "bits"}: `probability` is the share of the audio that carries
    a mark; `firevoice` says the mark is FireVoice's (its first 8 bits, one flipped bit allowed)."""
    from audioseal.libs.moshi.utils.compile import no_compile
    _gen, det, torch = _load()
    x = _to16(audio, sr)
    if len(x) < 400:
        return {"watermarked": False, "probability": 0.0, "firevoice": False, "kind": None, "bits": None, "seconds": round(len(x) / SR, 2)}
    step = int(WINDOW_S * SR)
    probs, msgs, weights = [], [], []
    with _lock, torch.inference_mode(), no_compile():
        for i in range(0, len(x), step):
            seg = x[i:i + step]
            if len(seg) < 400:
                continue
            p, m = det.detect_watermark(torch.from_numpy(seg.copy())[None, None], SR)
            probs.append(float(p))
            msgs.append(np.asarray(m[0].float().numpy()))
            weights.append(len(seg))
    w = np.asarray(weights, dtype=np.float64)
    prob = float(np.average(probs, weights=w))
    bits = [int(b >= 0.5) for b in np.average(np.stack(msgs), axis=0, weights=w)]
    ours = prob >= 0.5 and sum(int(a != b) for a, b in zip(bits[:8], TAG)) <= 1
    kind = None
    if ours:   # the kind byte, allowing one flipped bit (lossy codecs flip the odd one)
        dist = {name: sum(int(x != y) for x, y in zip(bits[8:], _bits(name)[8:])) for name in KINDS}
        best = min(dist, key=dist.get)
        kind = best if dist[best] <= 1 else None
    return {"watermarked": prob >= 0.5, "probability": round(prob, 3), "firevoice": ours, "kind": kind, "bits": "".join(map(str, bits)),
            "seconds": round(len(x) / SR, 2)}
