"""Edit words inside a finished take without re-recording the rest of it.

The passage is generated again with the new text (same voice, style, pace; continuation cloning keeps the voice), then
only the part that changed is spliced in: the words before and after the edit come from the original take, the new
words from the new one. Word times come from the speech check of both takes; the cuts themselves are moved to the
quietest moment near each word boundary and joined with short equal-power crossfades, so a cut never lands inside a
syllable.

When the change is most of the passage, or the takes' words cannot be lined up, the whole new take is used instead.
"""
from __future__ import annotations

import re
from typing import Optional

import numpy as np

TOK = re.compile(r"[a-z0-9']+")
XFADE_S = 0.012
SEARCH_S = 0.12
MAX_CHANGED = 0.6       # above this share of the passage's words changed, splicing gains nothing


def _key(w) -> str:
    t = w["text"] if isinstance(w, dict) else w.text
    return " ".join(TOK.findall(str(t).lower()))


def _wd(w) -> dict:
    return w if isinstance(w, dict) else {"text": w.text, "start": float(w.start), "end": float(w.end)}


def common_edges(a: list, b: list) -> tuple[int, int]:
    """(shared leading words, shared trailing words) of two word lists, never overlapping."""
    ka, kb = [_key(w) for w in a], [_key(w) for w in b]
    p = 0
    while p < len(ka) and p < len(kb) and ka[p] == kb[p]:
        p += 1
    s = 0
    while s < len(ka) - p and s < len(kb) - p and ka[-1 - s] == kb[-1 - s]:
        s += 1
    return p, s


def quiet_point(a: np.ndarray, sr: int, t: float, lo: float, hi: float) -> int:
    """The sample of the quietest 10 ms frame within [max(lo, t - SEARCH_S), min(hi, t + SEARCH_S)]."""
    start, end = max(lo, t - SEARCH_S, 0.0), min(hi, t + SEARCH_S, len(a) / sr)
    if end - start < 0.02:
        return int(round(min(max(t, 0.0), len(a) / sr) * sr))
    frame = max(1, int(sr * 0.01))
    i0, i1 = int(start * sr), int(end * sr)
    seg = a[i0:i1]
    n = len(seg) // frame
    if n == 0:
        return int(t * sr)
    e = (seg[: n * frame].reshape(n, frame) ** 2).mean(axis=1)
    # prefer the frame nearest the guess among the quietest ones
    floor = e.min()
    cand = np.where(e <= floor * 2.0 + 1e-12)[0]
    guess = (t - start) * sr / frame
    k = int(cand[np.argmin(np.abs(cand - guess))])
    return i0 + k * frame + frame // 2


def _boundary(words: list, k: int) -> tuple[float, float, float]:
    """Guess and search limits for the boundary just before word k (k may be len(words): the end)."""
    if k <= 0:
        return 0.0, 0.0, 0.0
    prev_end = float(words[k - 1]["end"])
    if k >= len(words):
        return prev_end, float(words[k - 1]["start"]), prev_end + SEARCH_S
    nxt = float(words[k]["start"])
    return (prev_end + nxt) / 2, float(words[k - 1]["start"]) + 0.03, nxt + 0.03


def _join(parts: list[np.ndarray], sr: int) -> np.ndarray:
    """Concatenate with an equal-power crossfade at each join."""
    n = max(1, int(sr * XFADE_S))
    out = parts[0].astype(np.float32)
    for p in parts[1:]:
        p = p.astype(np.float32)
        k = min(n, len(out), len(p))
        if k < 2:
            out = np.concatenate([out, p])
            continue
        x = np.linspace(0.0, np.pi / 2, k, dtype=np.float32)
        mid = out[-k:] * np.cos(x) + p[:k] * np.sin(x)
        out = np.concatenate([out[:-k], mid, p[k:]])
    return out


def splice(old_audio: np.ndarray, old_words: list, new_audio: np.ndarray, new_words: list, sr: int) -> Optional[dict]:
    """-> {"audio", "words", "changed": [old_from, old_to, new_from, new_to] in words, "cuts_s": [...]} or None when the
    whole new take should be used (most of it changed, or no words to line up)."""
    ow, nw = [_wd(w) for w in old_words], [_wd(w) for w in new_words]
    if not ow or not nw:
        return None
    p, s = common_edges(ow, nw)
    o_from, o_to, n_from, n_to = p, len(ow) - s, p, len(nw) - s
    if o_from == o_to and n_from == n_to:
        return {"audio": old_audio.astype(np.float32), "words": ow, "changed": [p, p, p, p], "cuts_s": [], "unchanged": True}
    changed = max(o_to - o_from, n_to - n_from) / max(len(ow), len(nw))
    if changed > MAX_CHANGED or (p == 0 and s == 0):
        return None
    # where the edit starts and ends, in both takes
    oa = quiet_point(old_audio, sr, *_boundary(ow, o_from)) if o_from > 0 else 0
    na = quiet_point(new_audio, sr, *_boundary(nw, n_from)) if n_from > 0 else 0
    ob = quiet_point(old_audio, sr, *_boundary(ow, o_to)) if s > 0 else len(old_audio)
    nb = quiet_point(new_audio, sr, *_boundary(nw, n_to)) if s > 0 else len(new_audio)
    if ob < oa:
        ob = oa
    if nb <= na:
        return None
    mid = new_audio[na:nb]
    # match the new words' level to the take around them (both are already level-matched; this removes small steps)
    ref = np.concatenate([old_audio[max(0, oa - sr // 2):oa], old_audio[ob:ob + sr // 2]])
    if len(ref) > sr // 10 and len(mid) > sr // 20:
        rms = lambda x: float(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-9)  # noqa: E731
        mid = mid * float(np.clip(rms(ref) / rms(mid), 0.7, 1.4))
    parts = [old_audio[:oa], mid, old_audio[ob:]]
    audio = _join([x for x in parts if len(x)], sr)
    # word times: old prefix as is, new words shifted to where they now sit, old suffix shifted by the length change
    xf = int(sr * XFADE_S)
    shift_mid = (oa - na - (xf if oa > 0 else 0)) / sr
    shift_tail = ((oa - (xf if oa > 0 else 0)) + (nb - na) - (xf if ob < len(old_audio) else 0) - ob) / sr
    words = [dict(w) for w in ow[:o_from]]
    words += [{"text": w["text"], "start": round(w["start"] + shift_mid, 3), "end": round(w["end"] + shift_mid, 3)} for w in nw[n_from:n_to]]
    words += [{"text": w["text"], "start": round(w["start"] + shift_tail, 3), "end": round(w["end"] + shift_tail, 3)} for w in ow[o_to:]]
    return {"audio": audio, "words": words, "changed": [o_from, o_to, n_from, n_to],
            "cuts_s": [round(oa / sr, 3), round(ob / sr, 3)], "unchanged": False}
