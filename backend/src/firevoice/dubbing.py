"""Dubbing: put a recording's speech into another language, on the original timeline.

The service does the heavy parts (speech to text, translation, rendering); this module holds the timing logic:

* `units`: the transcript's segments as lines to dub, with very short bits merged into their neighbour;
* `fit`: a rendered line sped up (never more than 1.3x, so it stays natural) to fit the time the original took;
* `assemble`: every line placed at its original start, or right after the previous one when that ran long, so the
  dub drifts at most until the next pause and then catches up.
"""
from __future__ import annotations

import re
from typing import Optional

import numpy as np

MAX_SPEED = 1.3
MIN_GAP_S = 0.12


def units(segments: list[dict], min_s: float = 1.2, max_s: float = 15.0) -> list[dict]:
    """[{start, end, text, speaker?}] -> the same, with lines shorter than `min_s` joined to the line before when the
    same person says them and the result stays under `max_s`."""
    out: list[dict] = []
    for s in segments:
        text = re.sub(r"\s+", " ", str(s.get("text") or "")).strip()
        if not text:
            continue
        seg = {"start": float(s["start"]), "end": float(s["end"]), "text": text, "speaker": s.get("speaker")}
        prev = out[-1] if out else None
        short = (seg["end"] - seg["start"]) < min_s or (prev is not None and (prev["end"] - prev["start"]) < min_s)
        if prev is not None and short and prev.get("speaker") == seg.get("speaker") and seg["end"] - prev["start"] <= max_s \
                and seg["start"] - prev["end"] < 0.8:
            prev["end"] = seg["end"]
            prev["text"] = f"{prev['text']} {seg['text']}"
        else:
            out.append(seg)
    return out


def fit(audio: np.ndarray, sr: int, slot_s: float, tempo=None) -> tuple[np.ndarray, float]:
    """Speed `audio` up to fit `slot_s` seconds (at most MAX_SPEED). -> (audio, speed used). `tempo(a, sr, factor)` is the
    time-stretch to use (audio.change_tempo by default; injectable for tests)."""
    dur = len(audio) / sr
    if slot_s <= 0 or dur <= slot_s:
        return audio, 1.0
    speed = min(MAX_SPEED, dur / slot_s)
    if tempo is None:
        from . import audio as A
        tempo = A.change_tempo
    return tempo(audio, sr, speed), round(speed, 3)


def assemble(lines: list[tuple[float, np.ndarray]], sr: int, total_s: float) -> tuple[np.ndarray, list[float]]:
    """Mix each (start seconds, audio) onto one track. A line that would overlap the one before starts right after it.
    -> (track, where each line actually starts)."""
    placed, t_free = [], 0.0
    for start, a in lines:
        at = max(start, t_free + (MIN_GAP_S if t_free > 0 else 0.0))
        placed.append(round(at, 3))
        t_free = at + len(a) / sr
    end = max([total_s] + [p + len(a) / sr for p, (_s, a) in zip(placed, lines)])
    track = np.zeros(int(round(end * sr)) + 1, dtype=np.float32)
    for at, (_s, a) in zip(placed, lines):
        i = int(round(at * sr))
        track[i:i + len(a)] += a[: len(track) - i]
    return track, placed


def slot(lines: list[dict], i: int, total_s: float) -> float:
    """Seconds line i may take: its own length plus the pause after it (up to the next line), at most 1.5 s more."""
    ln = lines[i]
    nxt = lines[i + 1]["start"] if i + 1 < len(lines) else total_s
    return max(0.3, min(nxt, ln["end"] + 1.5) - ln["start"])


def subtitles(lines: list[dict], fmt: str = "srt") -> str:
    """Subtitles of the dubbed lines at the times they are heard."""
    def ts(t: float, sep: str) -> str:
        ms = int(round(max(0.0, t) * 1000))
        h, ms = divmod(ms, 3_600_000)
        m, ms = divmod(ms, 60_000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"
    sep = "," if fmt == "srt" else "."
    rows = []
    for k, ln in enumerate(lines, 1):
        who = f"{ln['speaker']}: " if ln.get("speaker") and len({x.get('speaker') for x in lines}) > 1 else ""
        head = f"{k}\n" if fmt == "srt" else ""
        rows.append(f"{head}{ts(ln['at'], sep)} --> {ts(ln['at'] + ln['duration'], sep)}\n{who}{ln.get('translation_roman') or ln['translation']}\n")
    return ("" if fmt == "srt" else "WEBVTT\n\n") + "\n".join(rows)


def voice_for(speaker: Optional[str], cast: Optional[dict], default: str) -> str:
    return (cast or {}).get(speaker or "", default) if speaker else default
