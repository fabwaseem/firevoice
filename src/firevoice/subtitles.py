"""Subtitles (SRT and WebVTT) from word timings.

Cues follow the speech: a cue ends at the end of a sentence once it has run at least a second, at a pause of more than
0.6 s, or when it would pass two lines of 42 characters or 6 seconds. Cue ends never overlap the next cue.
"""
from __future__ import annotations

import re

MAX_CHARS = 84          # two lines of 42, the usual broadcast limit
MAX_SECONDS = 6.0
MIN_SECONDS = 1.0
GAP_BREAK = 0.6


def _get(w, k):
    return w[k] if isinstance(w, dict) else getattr(w, k)


def cues(words) -> list[dict]:
    """-> [{"start", "end", "text"}] in seconds."""
    out, cur = [], []

    def close():
        if cur:
            out.append({"start": _get(cur[0], "start"), "end": _get(cur[-1], "end"), "text": " ".join(str(_get(w, "text")).strip() for w in cur)})
            cur.clear()
    for i, w in enumerate(words):
        text = str(_get(w, "text")).strip()
        if not text:
            continue
        if cur:
            gap = _get(w, "start") - _get(cur[-1], "end")
            length = len(" ".join(str(_get(x, "text")) for x in cur)) + 1 + len(text)
            dur = _get(w, "end") - _get(cur[0], "start")
            if gap > GAP_BREAK or length > MAX_CHARS or dur > MAX_SECONDS:
                close()
        cur.append(w)
        if re.search(r"[.!?]['\")\]]*$", text) and _get(w, "end") - _get(cur[0], "start") >= MIN_SECONDS:
            close()
    close()
    for a, b in zip(out, out[1:]):
        a["end"] = min(a["end"], b["start"] - 0.02)
    for c in out:
        c["end"] = max(c["end"], c["start"] + 0.3)
    return out


def _wrap(text: str) -> str:
    """At most two lines, split near the middle on a space."""
    if len(text) <= MAX_CHARS // 2:
        return text
    mid = len(text) // 2
    left, right = text.rfind(" ", 0, mid + 1), text.find(" ", mid)
    cut = left if left > 0 and (right < 0 or mid - left <= right - mid) else right
    return text if cut <= 0 else text[:cut] + "\n" + text[cut + 1:]


def _ts(t: float, sep: str) -> str:
    ms = int(round(max(0.0, t) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def srt(words) -> str:
    return "\n".join(f"{i}\n{_ts(c['start'], ',')} --> {_ts(c['end'], ',')}\n{_wrap(c['text'])}\n" for i, c in enumerate(cues(words), 1))


def vtt(words) -> str:
    return "WEBVTT\n\n" + "\n".join(f"{_ts(c['start'], '.')} --> {_ts(c['end'], '.')}\n{_wrap(c['text'])}\n" for c in cues(words))


def render(words, fmt: str) -> tuple[str, str]:
    """-> (text, media type) for fmt "srt" or "vtt"."""
    fmt = (fmt or "srt").lower()
    if fmt == "srt":
        return srt(words), "application/x-subrip"
    if fmt == "vtt":
        return vtt(words), "text/vtt"
    raise ValueError(f"unknown subtitle format {fmt!r}; use srt or vtt")
