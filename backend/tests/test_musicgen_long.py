"""MusicGen past 30 s: continued pass by pass (fake model, no weights needed)."""
import types

import numpy as np
import torch

from firevoice.core.adapters.musicgen import MusicGenAdapter

SR, FPS = 1000, 50          # small rate keeps the test fast; 20 samples per codec frame


class _Inp(dict):
    def to(self, _dev):
        return self


def _adapter():
    calls = []

    def proc(text, audio=None, sampling_rate=None, padding=True, return_tensors="pt"):
        d = _Inp(text=text)
        if audio is not None:
            d["input_values"] = torch.tensor(np.asarray(audio[0]))[None, None]
        return d

    def generate(**kw):
        n = kw["max_new_tokens"] * SR // FPS
        new = np.full(n, 0.5 + 0.1 * len(calls), np.float32)   # each pass at its own level, so seams show
        k = kw["input_values"].shape[-1] if "input_values" in kw else 0
        calls.append({"prompt": k, "new": n})
        # like the model: the context comes back decoded again by this pass, flowing into the new music
        return torch.tensor(np.concatenate([np.full(k, new[0] if n else 0, np.float32), new]))[None, None]

    a = MusicGenAdapter.__new__(MusicGenAdapter)
    a.sr, a.dev, a.proc = SR, "cpu", proc
    a.m = types.SimpleNamespace(config=types.SimpleNamespace(audio_encoder=types.SimpleNamespace(frame_rate=FPS)),
                                dtype=torch.float32, generate=generate)
    return a, calls


def test_short_music_is_one_pass():
    a, calls = _adapter()
    pieces = list(a._synth_stream("piano", None, {"duration": 8}, 1))
    assert len(pieces) == 1 and len(pieces[0]) == 8 * SR and len(calls) == 1
    assert pieces[0][-1] > 0.4                            # no fade on a bed that may loop


def test_long_music_continues_in_passes():
    a, calls = _adapter()
    pieces = list(a._synth_stream("synthwave", None, {"duration": 75}, 1))
    song = np.concatenate(pieces)
    assert len(song) == 75 * SR                           # exactly the length asked for
    assert len(pieces) == len(calls) == 4                 # 30 s, then 20 + 20 + the last few seconds
    assert calls[0]["prompt"] == 0 and all(c["prompt"] == 10 * SR for c in calls[1:])   # each continuation hears 10 s
    assert all(c["new"] <= 20 * SR for c in calls[1:])
    seam = 30 * SR
    assert song[seam - 100] == np.float32(0.5) and song[seam + 10] == np.float32(0.6)
    mid = song[seam - 80:seam]                            # the 80 ms before the seam rise from one pass to the next
    assert 0.5 - 1e-6 <= mid.min() and mid.max() <= 0.6 + 1e-6 and mid[-1] > mid[0] and np.all(np.diff(mid) >= 0)
    assert abs(song[-1]) < 1e-3 and song[-3 * SR] > 0.4   # a soft ending, only at the end


def test_length_is_capped():
    a, _ = _adapter()
    assert len(np.concatenate(list(a._synth_stream("x", None, {"duration": 999}, 1)))) == 180 * SR
