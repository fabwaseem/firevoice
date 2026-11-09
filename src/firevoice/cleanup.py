"""Reference-clip quality check and cleanup.

`analyze` measures what makes a clip good to clone from: speech level against the noise floor (an SNR estimate),
clipping, length and how much of it is silence. `clean` takes out steady noise and hum (an adaptive FFT denoiser
tuned to the clip's own noise floor), rumble below 70 Hz, and the silence at both ends, then sets a common level.

This is a signal-processing cleaner: it handles hiss, hum, fans and room noise well, but not music or other voices
under the speech.
"""
from __future__ import annotations

import numpy as np

from . import audio as A


def _frames_db(a: np.ndarray, sr: int, ms: int = 20) -> np.ndarray:
    frame = max(1, int(sr * ms / 1000))
    n = len(a) // frame
    if n == 0:
        return np.zeros(0)
    rms = np.sqrt((a[: n * frame].astype(np.float64).reshape(n, frame) ** 2).mean(axis=1) + 1e-12)
    return 20 * np.log10(rms)


def analyze(a: np.ndarray, sr: int) -> dict:
    """-> {duration, peak_db, clipped_pct, speech_db, noise_db, snr_db, silence_pct, verdict, notes}"""
    a = np.asarray(a, dtype=np.float32)
    dur = len(a) / sr if sr else 0.0
    if dur < 0.3:
        return {"duration": round(dur, 2), "verdict": "poor", "notes": ["the clip is too short to use"]}
    db = _frames_db(a, sr)
    srt = np.sort(db)
    noise = float(np.mean(srt[: max(1, len(srt) // 10)]))          # quietest 10% of 20 ms frames
    speech = float(np.mean(srt[-max(1, len(srt) * 4 // 10):]))     # loudest 40%
    snr = speech - noise
    peak = float(20 * np.log10(max(float(np.max(np.abs(a))), 1e-9)))
    clipped = float(np.mean(np.abs(a) >= 0.985)) * 100
    silence = float(np.mean(db < speech - 30)) * 100
    notes = []
    if snr < 20:
        notes.append(f"noisy: speech is only {snr:.0f} dB above the background (aim for 30 dB or more)")
    elif snr < 30:
        notes.append(f"some background noise ({snr:.0f} dB below the speech)")
    if clipped > 0.05:
        notes.append(f"clipped: {clipped:.2f}% of samples hit full scale (record a little quieter)")
    if dur < 5:
        notes.append(f"short: {dur:.1f} s (6 to 20 s of speech clones best)")
    elif dur > 30:
        notes.append(f"long: {dur:.0f} s (6 to 20 s is enough; long clips slow cloning down)")
    if silence > 45:
        notes.append(f"{silence:.0f}% of the clip is silence")
    if speech < -40:
        notes.append("very quiet recording")
    verdict = "good" if snr >= 30 and clipped <= 0.05 and 5 <= dur <= 30 else "poor" if snr < 18 or clipped > 1 or dur < 2 else "fair"
    return {"duration": round(dur, 2), "peak_db": round(peak, 1), "clipped_pct": round(clipped, 3), "speech_db": round(speech, 1),
            "noise_db": round(noise, 1), "snr_db": round(snr, 1), "silence_pct": round(silence, 1), "verdict": verdict, "notes": notes}


STRENGTH = ("light", "medium", "strong")
RNNOISE_URL = "https://raw.githubusercontent.com/richardpl/arnndn-models/master/sh.rnnn"


def _rnnoise_model():
    """RNNoise weights for ffmpeg's arnndn filter (speech model, about 300 KB), fetched once into FIREVOICE_HOME/models.
    None when they cannot be had (offline): cleaning then falls back to the FFT denoiser."""
    from pathlib import Path

    from .paths import models_dir
    f = models_dir() / "rnnoise" / "sh.rnnn"
    shared = Path.home() / ".firevoice" / "models" / "rnnoise" / "sh.rnnn"
    if not f.exists() and shared.exists():
        return shared
    if not f.exists():
        try:
            import urllib.request
            f.parent.mkdir(parents=True, exist_ok=True)
            data = urllib.request.urlopen(RNNOISE_URL, timeout=20).read()
            if not data.startswith(b"rnnoise-nu model file"):
                return None
            tmp = f.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(f)
        except Exception:
            return None
    return f


def _ff_path(p) -> str:
    """A path inside an ffmpeg filter argument: forward slashes, the drive colon escaped."""
    return str(p).replace("\\", "/").replace(":", "\\:")


def clean(a: np.ndarray, sr: int, strength: str = "medium") -> np.ndarray:
    """Denoise, cut rumble, trim the silent ends, set the level to -20 dBFS RMS.

    The denoiser is RNNoise (a small speech network, via ffmpeg) when its weights are available: light mixes it at 60%,
    medium uses it fully, strong adds an FFT pass tuned to the clip's noise floor. Without RNNoise all three use the
    FFT denoiser at increasing strength."""
    if strength not in STRENGTH:
        raise ValueError(f"strength must be one of {', '.join(STRENGTH)}")
    a = np.asarray(a, dtype=np.float32)
    db = _frames_db(a, sr)
    nf = float(np.mean(np.sort(db)[: max(1, len(db) // 10)])) if len(db) else -60.0
    nf = min(-20.0, max(-80.0, nf))
    model = _rnnoise_model()
    if model is not None:
        mix = {"light": 0.6, "medium": 1.0, "strong": 1.0}[strength]
        chain = f"highpass=f=70:p=2,aresample=48000,arnndn=m='{_ff_path(model)}':mix={mix}"
        if strength == "strong":
            chain += f",afftdn=nr=10:nf={nf - 12:.1f}:tn=1"
    else:
        nr = {"light": 8, "medium": 14, "strong": 24}[strength]
        chain = f"highpass=f=70:p=2,afftdn=nr={nr}:nf={nf:.1f}:tn=1"
        if strength == "strong":
            chain += f",afftdn=nr=12:nf={nf - 10:.1f}:tn=1"
    out = A.filter_audio(a, sr, chain + ",lowpass=f=16000" if sr > 32000 else chain)
    out = A.trim_silence(out, sr, thresh_db=-42.0, margin_ms=120)
    out = A.rms_match(out, sr, target_db=-20.0, max_gain=6.0)
    return A.fade(out, sr, ms=15)
