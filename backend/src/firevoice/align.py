"""Exact word times: CTC forced alignment of the words Whisper heard against the audio itself.

Whisper's word timestamps are often 0.1-0.2 s off (it tends to end a sentence's last word early). Forced alignment
with a character-level CTC model (wav2vec 2.0 base 960h, trained on LibriSpeech, MIT via fairseq/torchaudio) places each
word where its letters actually sound, to about 20 ms. English only: the multilingual aligner's weights are
non-commercial, so other languages keep Whisper's times.

A word the aligner cannot spell in its alphabet (digits, symbols) keeps Whisper's time, and so does a word the
aligner would move by more than MAX_SHIFT (a sign that the transcript and the audio disagree there). Turn it off with
FIREVOICE_ALIGN=off. The model (360 MB) downloads once, on first use.
"""
from __future__ import annotations

import os
import re
import threading
from typing import Optional

import numpy as np

from .types import Word

SR = 16000
MAX_SHIFT = 0.6
MAX_SECONDS = 90.0

_lock = threading.Lock()
_state: dict = {}


def enabled() -> bool:
    return os.environ.get("FIREVOICE_ALIGN", "on").lower() not in ("off", "0", "false", "no")


def _load():
    with _lock:
        if "model" not in _state:
            import torch
            import torchaudio
            bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
            dev = os.environ.get("FIREVOICE_ALIGN_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
            model = bundle.get_model().to(dev).eval()
            labels = bundle.get_labels()
            _state.update(model=model, labels={c: i for i, c in enumerate(labels)}, dev=dev, torch=torch)
        return _state


def _tokens(word: str, labels: dict) -> str:
    return "".join(c for c in re.sub(r"[^A-Z']", "", word.upper()) if c in labels)


def refine(audio: np.ndarray, sr: int, words: list[Word], offset: float = 0.0) -> list[Word]:
    """Words with exact times (seconds from the start of `audio`, plus `offset`). Never raises: on any problem the
    words come back as they were."""
    if not words or not enabled() or len(audio) / max(1, sr) > MAX_SECONDS:
        return words
    try:
        st = _load()
        import torchaudio.functional as F
        torch = st["torch"]
        labels = st["labels"]
        toks = [_tokens(w.text, labels) for w in words]
        idx = [i for i, t in enumerate(toks) if t]
        if not idx:
            return words
        transcript = "|".join(toks[i] for i in idx)
        y = np.asarray(audio, dtype=np.float32)
        y = y.mean(axis=1) if y.ndim > 1 else y
        if sr != SR:
            import librosa
            y = librosa.resample(y, orig_sr=sr, target_sr=SR)
        with _lock, torch.inference_mode():
            wav = torch.from_numpy(y)[None].to(st["dev"])
            emission, _ = st["model"](wav)
            emission = torch.log_softmax(emission, dim=-1).cpu()
        targets = torch.tensor([[labels[c] for c in transcript]], dtype=torch.int32)
        if targets.size(1) > emission.size(1):
            return words
        aligned, scores = F.forced_align(emission, targets, blank=0)
        spans = F.merge_tokens(aligned[0], scores[0].exp())
        sec = (len(y) / SR) / emission.size(1)
        out = list(words)
        k = 0                                   # position in spans (one span per transcript character)
        for wi, i in enumerate(idx):
            n = len(toks[i])
            chars = spans[k:k + n]
            k += n + (1 if wi < len(idx) - 1 else 0)     # skip the "|" between words
            if len(chars) < n:
                break
            start, end = chars[0].start * sec + offset, chars[-1].end * sec + offset
            w = words[i]
            if abs(start - w.start) <= MAX_SHIFT and abs(end - w.end) <= MAX_SHIFT and end > start:
                out[i] = Word(w.text, round(start, 3), round(end, 3))
        return out
    except Exception:
        return words


def refine_segments(audio: np.ndarray, sr: int, words: list[Word], segments: list[dict]) -> list[Word]:
    """Long audio, one Whisper segment at a time (each with a little margin)."""
    if not enabled() or not segments:
        return refine(audio, sr, words)
    out = list(words)
    for seg in segments:
        ids = seg.get("words") or []
        if not ids:
            continue
        a0 = max(0.0, float(seg["start"]) - 0.3)
        a1 = min(len(audio) / sr, float(seg["end"]) + 0.3)
        part = audio[int(a0 * sr):int(a1 * sr)]
        local = [Word(out[i].text, out[i].start - a0, out[i].end - a0) for i in ids]
        fixed = refine(part, sr, local, offset=a0)
        for i, before, after in zip(ids, local, fixed):
            if after is not before:            # refined (already shifted back by offset); untouched words stay as they were
                out[i] = after
    return out
