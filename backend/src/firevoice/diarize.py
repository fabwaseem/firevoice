"""Who speaks when, without a dedicated diarization model: each transcript segment gets a voice embedding (the same
speaker encoder the listening test uses), and segments are grouped by similarity. Good for interviews and podcasts
with clearly different voices; it does not split overlapping speech.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

SAME = 0.75          # cosine similarity above which two segments are taken to be the same speaker


def _embed(a: np.ndarray, sr: int) -> np.ndarray:
    from resemblyzer import VoiceEncoder, preprocess_wav
    enc = _embed.__dict__.get("enc")
    if enc is None:                      # built once: setdefault would build (and load) a new encoder on every call
        enc = _embed.__dict__["enc"] = VoiceEncoder(device="cpu", verbose=False)
    return enc.embed_utterance(preprocess_wav(np.asarray(a, dtype=np.float32), sr))


def label_speakers(audio: np.ndarray, sr: int, segments: list[dict], speakers: Optional[int] = None, embed=None) -> list[str]:
    """-> one "Speaker N" label per segment (numbered in order of first appearance). `embed(audio, sr)` -> a unit
    vector per segment (default: the speaker encoder)."""
    embed = embed or _embed
    embs: list[Optional[np.ndarray]] = []
    for s in segments:
        a = audio[int(s["start"] * sr): int(s["end"] * sr)]
        if len(a) < sr * 0.6:
            embs.append(None)                     # too short to judge: takes its neighbour's speaker
            continue
        try:
            embs.append(embed(a, sr))
        except Exception:
            embs.append(None)
    # online grouping, then merge the closest groups down to `speakers`
    cents: list[np.ndarray] = []
    counts: list[int] = []
    assign: list[Optional[int]] = []
    for e in embs:
        if e is None:
            assign.append(None)
            continue
        sims = [float(e @ (c / np.linalg.norm(c))) for c in cents]
        k = int(np.argmax(sims)) if sims else -1
        if k >= 0 and sims[k] >= SAME and not (speakers and len(cents) < speakers and sims[k] < 0.85):
            cents[k] = cents[k] + e
            counts[k] += 1
        else:
            cents.append(e.copy())
            counts.append(1)
            k = len(cents) - 1
        assign.append(k)
    if speakers and len(cents) > speakers:
        groups = {i: {i} for i in range(len(cents))}
        while len(groups) > speakers:
            keys = list(groups)
            best, pair = -2.0, None
            for i in range(len(keys)):
                for j in range(i + 1, len(keys)):
                    a, b = cents[keys[i]], cents[keys[j]]
                    s = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))
                    if s > best:
                        best, pair = s, (keys[i], keys[j])
            i, j = pair
            cents[i] = cents[i] + cents[j]
            groups[i] |= groups.pop(j)
        remap = {m: g for g, ms in groups.items() for m in ms}
        assign = [None if a is None else remap[a] for a in assign]
    # fill short segments from the nearest labelled neighbour
    for i, a in enumerate(assign):
        if a is None:
            prev = next((assign[j] for j in range(i - 1, -1, -1) if assign[j] is not None), None)
            nxt = next((assign[j] for j in range(i + 1, len(assign)) if assign[j] is not None), None)
            assign[i] = prev if prev is not None else (nxt if nxt is not None else 0)
    order: dict[int, int] = {}
    for a in assign:
        order.setdefault(a, len(order) + 1)
    return [f"Speaker {order[a]}" for a in assign]
