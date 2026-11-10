"""How good a piece of speech is: whose voice it is, how clean it sounds, and whether the voice stays put.

* **Speaker similarity** with WavLM (microsoft/wavlm-base-plus-sv, MIT): an x-vector speaker model on WavLM features,
  far sharper than resemblyzer at telling voices apart (a render against its own voice ~0.99, against another ~0.2-0.6;
  same speaker from about 0.86). Falls back to resemblyzer when transformers is missing (same speaker from 0.72).
* **DNSMOS** (Microsoft, via speechmos): predicted listener scores 1-5 for overall quality, the speech signal, and the
  background (noise); P.808 is the newer overall model.
* **Drift**: a long take cut into windows, each compared with the voice's clip (or the take's own median voice), plus
  pitch and loudness per window, flagging where the voice, pitch or level wanders.

Everything runs on the CPU (the GPU stays with the engines): about 0.05 s per second of audio for similarity and
0.02 s for DNSMOS.
"""
from __future__ import annotations

import threading
from typing import Optional

import numpy as np

SR = 16000
WAVLM = "microsoft/wavlm-base-plus-sv"
SAME = {"wavlm": 0.86, "resemblyzer": 0.72}

_lock = threading.Lock()
_cache: dict = {}


def _to16(a: np.ndarray, sr: int) -> np.ndarray:
    a = np.asarray(a, dtype=np.float32)
    a = a.mean(axis=1) if a.ndim > 1 else a
    if sr == SR:
        return a
    import librosa
    return librosa.resample(a, orig_sr=sr, target_sr=SR).astype(np.float32)


def _wavlm():
    with _lock:
        if "wavlm" not in _cache:
            import torch
            from transformers import AutoFeatureExtractor, WavLMForXVector
            _cache["wavlm"] = (AutoFeatureExtractor.from_pretrained(WAVLM), WavLMForXVector.from_pretrained(WAVLM).eval(), torch)
        return _cache["wavlm"]


def _resemblyzer():
    with _lock:
        if "rz" not in _cache:
            from resemblyzer import VoiceEncoder
            _cache["rz"] = VoiceEncoder(device="cpu", verbose=False)
        return _cache["rz"]


def backend() -> str:
    import importlib.util
    return "wavlm" if importlib.util.find_spec("transformers") and importlib.util.find_spec("torch") else "resemblyzer"


def embed(a: np.ndarray, sr: int, which: Optional[str] = None) -> np.ndarray:
    """A unit-length speaker embedding of 16 kHz mono speech (any rate in)."""
    y = _to16(a, sr)
    which = which or backend()
    if which == "wavlm":
        fe, m, torch = _wavlm()
        with _lock, torch.inference_mode():
            e = m(**fe(y, sampling_rate=SR, return_tensors="pt")).embeddings[0].numpy()
    else:
        from resemblyzer import preprocess_wav
        enc = _resemblyzer()
        with _lock:
            e = enc.embed_utterance(preprocess_wav(y, SR))
    return (e / (np.linalg.norm(e) + 1e-9)).astype(np.float32)


def similarity(a: np.ndarray, sr: int, b: np.ndarray, sr_b: int) -> dict:
    which = backend()
    v = float(embed(a, sr, which) @ embed(b, sr_b, which))
    return {"value": round(v, 3), "backend": which, "same_speaker": v >= SAME[which]}


def mos(a: np.ndarray, sr: int) -> Optional[dict]:
    """DNSMOS scores (1-5), or None without speechmos. Long audio is scored in 10 s pieces and averaged."""
    try:
        from speechmos import dnsmos
    except ImportError:
        return None
    y = _to16(a, sr)
    if len(y) < SR:
        return None
    peak = float(np.abs(y).max()) or 1.0
    y = y / peak * 0.9 if peak > 1.0 else y
    step, rows = 10 * SR, []
    for i in range(0, len(y), step):
        seg = y[i:i + step]
        if len(seg) >= 3 * SR:
            with _lock:
                rows.append(dnsmos.run(seg, sr=SR))
    if not rows:
        with _lock:
            rows = [dnsmos.run(y, sr=SR)]
    avg = lambda k: round(float(np.mean([r[k] for r in rows])), 2)  # noqa: E731
    return {"overall": avg("ovrl_mos"), "signal": avg("sig_mos"), "background": avg("bak_mos"), "p808": avg("p808_mos")}


def _f0_median(y: np.ndarray) -> Optional[float]:
    import librosa
    try:
        f0 = librosa.yin(y, fmin=60, fmax=500, sr=SR, frame_length=1024)
        rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=256)[0][: len(f0)]
        voiced = f0[: len(rms)][rms > rms.max() * 0.1]
        return round(float(np.median(voiced)), 1) if len(voiced) > 10 else None
    except Exception:
        return None


def drift(a: np.ndarray, sr: int, ref: Optional[np.ndarray] = None, ref_sr: Optional[int] = None, window_s: float = 8.0) -> dict:
    """The take in windows: speaker similarity (to the voice's clip when given, else to the take's own median voice),
    median pitch and level per window, and flags where they wander. Short takes are one window."""
    y = _to16(a, sr)
    which = backend()
    n = max(1, int(round(len(y) / (window_s * SR))))
    edges = np.linspace(0, len(y), n + 1).astype(int)
    wins = []
    for i in range(n):
        seg = y[edges[i]:edges[i + 1]]
        if len(seg) < SR:
            continue
        lvl = 20 * np.log10(float(np.sqrt(np.mean(seg ** 2))) + 1e-9)
        wins.append({"start": round(edges[i] / SR, 2), "end": round(edges[i + 1] / SR, 2), "emb": embed(seg, SR, which),
                     "f0": _f0_median(seg), "level_db": round(lvl, 1)})
    if not wins:
        return {"windows": [], "flags": [], "backend": which}
    anchor = embed(ref, ref_sr or SR, which) if ref is not None else None
    if anchor is None:
        m = np.mean([w["emb"] for w in wins], axis=0)
        anchor = m / (np.linalg.norm(m) + 1e-9)
    for w in wins:
        w["similarity"] = round(float(w.pop("emb") @ anchor), 3)
    sims = np.array([w["similarity"] for w in wins])
    f0s = [w["f0"] for w in wins if w["f0"]]
    f0_med = float(np.median(f0s)) if f0s else None
    lvl_med = float(np.median([w["level_db"] for w in wins]))
    flags = []
    floor = min(SAME[which] if ref is not None else 1.0, float(np.median(sims)) - 0.08)
    for w in wins:
        why = []
        if w["similarity"] < floor:
            why.append(f"voice drifts (similarity {w['similarity']})")
        if f0_med and w["f0"] and abs(w["f0"] - f0_med) / f0_med > 0.18:
            why.append(f"pitch {w['f0']:.0f} Hz vs {f0_med:.0f} Hz typical")
        if abs(w["level_db"] - lvl_med) > 5:
            why.append(f"level {w['level_db']:+.1f} dB vs {lvl_med:.1f} dB typical")
        if why:
            flags.append({"start": w["start"], "end": w["end"], "why": why})
    return {"windows": wins, "flags": flags, "backend": which, "min_similarity": round(float(sims.min()), 3),
            "spread": round(float(sims.max() - sims.min()), 3), "pitch_hz": round(f0_med, 1) if f0_med else None,
            "compared_with": "the voice's clip" if ref is not None else "the take's own median voice"}


def report(a: np.ndarray, sr: int, ref: Optional[np.ndarray] = None, ref_sr: Optional[int] = None) -> dict:
    """Everything above for one piece of audio, plus a one-line verdict."""
    out = {"duration": round(len(a) / sr, 2), "mos": mos(a, sr)}
    out["similarity"] = similarity(a, sr, ref, ref_sr) if ref is not None else None
    out["drift"] = drift(a, sr, ref, ref_sr)
    notes = []
    if out["mos"] and out["mos"]["overall"] < 3.0:
        notes.append(f"sounds rough (listener score {out['mos']['overall']} of 5)")
    if out["mos"] and out["mos"]["background"] < 3.5:
        notes.append("noticeable background noise")
    if out["similarity"] and not out["similarity"]["same_speaker"]:
        notes.append(f"does not sound like the voice (similarity {out['similarity']['value']})")
    if out["drift"]["flags"]:
        notes.append(f"{len(out['drift']['flags'])} stretch(es) where the voice, pitch or level wanders")
    out["verdict"] = "good" if not notes else "check"
    out["notes"] = notes
    return out
