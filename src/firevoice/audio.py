"""Audio helpers: silence trimming, fades, tempo, and the studio post chain (ffmpeg)."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf


def _ffmpeg() -> str:
    p = shutil.which("ffmpeg")
    if not p:
        raise RuntimeError("ffmpeg not found on PATH")
    return p


def trim_silence(a: np.ndarray, sr: int, thresh_db: float = -38.0, margin_ms: int = 25) -> np.ndarray:
    if len(a) == 0:
        return a
    frame = max(1, int(sr * 0.01))
    n = len(a) // frame
    if n == 0:
        return a
    rms = np.sqrt((a[: n * frame].reshape(n, frame) ** 2).mean(axis=1) + 1e-12)
    peak = rms.max()
    if peak <= 1e-6:
        return a
    loud = np.where(rms > peak * 10 ** (thresh_db / 20))[0]
    if len(loud) == 0:
        return a
    m = int(sr * margin_ms / 1000)
    s = max(0, loud[0] * frame - m)
    e = min(len(a), (loud[-1] + 1) * frame + m)
    return a[s:e]


def lead_trim_samples(a: np.ndarray, sr: int, thresh_db: float = -38.0, margin_ms: int = 25) -> int:
    """How many samples trim_silence removes from the start (to correct word times)."""
    frame = max(1, int(sr * 0.01))
    n = len(a) // frame
    if n == 0:
        return 0
    rms = np.sqrt((a[: n * frame].reshape(n, frame) ** 2).mean(axis=1) + 1e-12)
    peak = rms.max()
    if peak <= 1e-6:
        return 0
    loud = np.where(rms > peak * 10 ** (thresh_db / 20))[0]
    return 0 if len(loud) == 0 else max(0, loud[0] * frame - int(sr * margin_ms / 1000))


def fade(a: np.ndarray, sr: int, ms: int = 12) -> np.ndarray:
    n = min(len(a) // 2, int(sr * ms / 1000))
    if n <= 0:
        return a
    a = a.copy()
    ramp = np.linspace(0, 1, n, dtype=np.float32)
    a[:n] *= ramp
    a[-n:] *= ramp[::-1]
    return a


def silence(ms: int, sr: int) -> np.ndarray:
    return np.zeros(int(sr * ms / 1000), dtype=np.float32)


def _run(args: list[str], data: bytes) -> bytes:
    p = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode(errors="replace")[-600:])
    return p.stdout


def filter_audio(a: np.ndarray, sr: int, af: str) -> np.ndarray:
    raw = _run(
        [_ffmpeg(), "-v", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0", "-af", af, "-f", "f32le", "-ar", str(sr), "-ac", "1", "pipe:1"],
        a.astype("<f4").tobytes(),
    )
    return np.frombuffer(raw, dtype="<f4").copy()


def resample(a: np.ndarray, sr: int, out_sr: int) -> np.ndarray:
    if sr == out_sr or not len(a):
        return a
    raw = _run([_ffmpeg(), "-v", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0", "-af", "aresample=resampler=soxr",
                "-f", "f32le", "-ar", str(out_sr), "-ac", "1", "pipe:1"], a.astype("<f4").tobytes())
    return np.frombuffer(raw, dtype="<f4").copy()


def soft_limit(a: np.ndarray, knee: float = 0.8, ceiling: float = 0.98) -> np.ndarray:
    """Leave everything under `knee` alone and bend louder samples smoothly toward `ceiling` (no hard clipping)."""
    a = np.asarray(a, dtype=np.float32)
    m = np.abs(a)
    over = m > knee
    if not over.any():
        return a
    out = a.copy()
    room = ceiling - knee
    out[over] = np.sign(a[over]) * (knee + room * np.tanh((m[over] - knee) / room))
    return out


class StreamTempo:
    """The same `atempo` change as change_tempo(), for audio that arrives in pieces. Audio is buffered and cut at the
    quietest 10 ms once at least `min_s` has built up; each cut segment is time-stretched on its own. Cutting in near
    silence keeps the joins inaudible. (Piping one long-lived ffmpeg instead glitched: its raw-PCM reader can split
    samples on a pipe that delivers partial reads.)"""

    def __init__(self, sr: int, rate: float, min_s: float = 0.4):
        self.sr, self.rate = sr, rate
        self.min_n = int(sr * min_s)
        self.buf = np.zeros(0, np.float32)

    def push(self, a: np.ndarray) -> None:
        self.buf = np.concatenate([self.buf, np.asarray(a, dtype=np.float32)])

    def pull(self) -> np.ndarray:
        if len(self.buf) < self.min_n:
            return np.zeros(0, np.float32)
        frame = max(1, int(self.sr * 0.01))
        lo = int(len(self.buf) * 0.5) // frame        # cut in the second half, so segments stay a decent length
        n = len(self.buf) // frame
        if n - lo < 2:
            return np.zeros(0, np.float32)
        rms = np.sqrt((self.buf[: n * frame].reshape(n, frame) ** 2).mean(axis=1))
        cut = (lo + int(np.argmin(rms[lo:n]))) * frame + frame // 2
        seg, self.buf = self.buf[:cut], self.buf[cut:]
        return change_tempo(seg, self.sr, self.rate)

    def close(self) -> np.ndarray:
        seg, self.buf = self.buf, np.zeros(0, np.float32)
        return change_tempo(seg, self.sr, self.rate) if len(seg) else seg

    def kill(self) -> None:
        self.buf = np.zeros(0, np.float32)


def rms_match(a: np.ndarray, sr: int, target_db: float = -20.0, max_gain: float = 4.0) -> np.ndarray:
    """Bring a take to a common speech level (RMS of the louder 60% of frames) so consecutive takes do not jump."""
    if len(a) < sr // 20:
        return a
    frame = max(1, int(sr * 0.02))
    n = len(a) // frame
    rms = np.sqrt((a[: n * frame].reshape(n, frame) ** 2).mean(axis=1) + 1e-12)
    loud = np.sort(rms)[int(n * 0.4):]
    level = float(np.sqrt(np.mean(loud ** 2))) if len(loud) else float(np.sqrt(np.mean(a ** 2)) + 1e-9)
    g = min(max_gain, 10 ** (target_db / 20) / max(level, 1e-6))
    return soft_limit(a * g)          # loud peaks bend smoothly under 0.98 instead of clipping


def change_tempo(a: np.ndarray, sr: int, rate: float) -> np.ndarray:
    if abs(rate - 1.0) < 0.01:
        return a
    return filter_audio(a, sr, f"atempo={rate:.4f}")


def _measure_loudnorm(a: np.ndarray, sr: int, lufs: float, tp: float) -> dict | None:
    import json as _json
    p = subprocess.run(
        [_ffmpeg(), "-hide_banner", "-nostats", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
         "-af", f"loudnorm=I={lufs}:TP={tp}:LRA=9:print_format=json", "-f", "null", "-"],
        input=a.astype("<f4").tobytes(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    txt = p.stderr.decode(errors="replace")
    i = txt.rfind("{")
    try:
        d = _json.loads(txt[i: txt.rfind("}") + 1])
        if any(str(d[k]).strip("-").lower() in ("inf", "nan") for k in ("input_i", "input_tp", "input_lra", "input_thresh")):
            return None
        return d
    except Exception:
        return None


def studio_chain(a: np.ndarray, sr: int, lufs: float = -16.0, tp: float = -1.5) -> np.ndarray:
    """Voice-over polish: rumble cut, de-mud, de-esser, gentle presence and air, transparent two-stage
    compression, then two-pass (measured, linear) loudness normalisation with a true-peak ceiling."""
    pre = (
        "highpass=f=75:p=2,"
        "equalizer=f=220:t=q:w=1.1:g=-1.8,"
        "deesser=i=0.35:m=0.5:f=0.5,"
        "equalizer=f=3000:t=q:w=1.3:g=1.6,"
        "equalizer=f=11000:t=h:w=0.8:g=1.0,"
        "acompressor=threshold=-24dB:ratio=1.8:attack=18:release=220:makeup=1.5,"
        "acompressor=threshold=-16dB:ratio=3.5:attack=4:release=90:makeup=1.5"
    )
    b = filter_audio(a, sr, pre)
    m = _measure_loudnorm(b, sr, lufs, tp)
    if m:
        ln = (f"loudnorm=I={lufs}:TP={tp}:LRA=9:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
              f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    else:
        ln = f"loudnorm=I={lufs}:TP={tp}:LRA=9"
    ceiling = 10 ** ((tp - 0.3) / 20)
    return filter_audio(b, sr, f"{ln},alimiter=limit={ceiling:.3f}:level=disabled")


def write_audio(path: str | Path, a: np.ndarray, sr: int, bitrate: str = "192k") -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    a = np.clip(a, -1.0, 1.0)
    if path.suffix.lower() == ".wav":
        sf.write(str(path), a, sr, subtype="PCM_16")
        return
    raw = a.astype("<f4").tobytes()
    codec = {".mp3": ["-c:a", "libmp3lame", "-b:a", bitrate], ".m4a": ["-c:a", "aac", "-b:a", bitrate], ".flac": ["-c:a", "flac"], ".ogg": ["-c:a", "libvorbis"]}.get(path.suffix.lower())
    if codec is None:
        raise ValueError(f"unsupported output format {path.suffix}")
    _run([_ffmpeg(), "-y", "-v", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0", *codec, str(path)], raw)


FORMATS = {   # name -> (ffmpeg codec args, media type, file extension)
    "wav": (["-c:a", "pcm_s16le", "-f", "wav"], "audio/wav", "wav"),
    "mp3": (["-c:a", "libmp3lame", "-b:a", "{bitrate}", "-f", "mp3"], "audio/mpeg", "mp3"),
    "flac": (["-c:a", "flac", "-f", "flac"], "audio/flac", "flac"),
    "ogg": (["-c:a", "libvorbis", "-q:a", "5", "-f", "ogg"], "audio/ogg", "ogg"),
    "opus": (["-c:a", "libopus", "-b:a", "{bitrate}", "-f", "ogg"], "audio/ogg; codecs=opus", "opus"),
    "m4a": (["-c:a", "aac", "-b:a", "{bitrate}", "-f", "ipod", "-movflags", "+faststart"], "audio/mp4", "m4a"),   # real MP4 (written via a temp file)
    "pcm16": (["-c:a", "pcm_s16le", "-f", "s16le"], "audio/L16", "pcm"),
}


def media_type(fmt: str) -> str:
    return FORMATS[fmt][1]


def encode_bytes(a: np.ndarray, sr: int, fmt: str = "mp3", bitrate: str = "192k", out_sr: int | None = None) -> bytes:
    """Encode mono float audio to `fmt` (see FORMATS), optionally resampled to `out_sr`."""
    if fmt not in FORMATS:
        raise ValueError(f"unsupported format {fmt!r}; use one of {', '.join(FORMATS)}")
    a = np.clip(np.asarray(a, dtype=np.float32), -1.0, 1.0)
    if fmt == "wav" and not out_sr:
        import io
        buf = io.BytesIO()
        sf.write(buf, a, sr, subtype="PCM_16", format="WAV")
        return buf.getvalue()
    codec = [x.replace("{bitrate}", bitrate) for x in FORMATS[fmt][0]]
    rate = ["-ar", str(int(out_sr))] if out_sr else []
    if fmt == "m4a":
        # an MP4 container needs a seekable output (the index goes at the front), so it cannot be piped
        import os
        import tempfile
        fd, tmp = tempfile.mkstemp(suffix=".m4a")
        os.close(fd)
        try:
            _run([_ffmpeg(), "-y", "-v", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0", *rate, *codec, tmp], a.astype("<f4").tobytes())
            return Path(tmp).read_bytes()
        finally:
            os.remove(tmp)
    return _run([_ffmpeg(), "-v", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0", *rate, *codec, "pipe:1"], a.astype("<f4").tobytes())
