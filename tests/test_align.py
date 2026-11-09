"""Forced alignment: never breaks word times (off, failures, big shifts), and long audio is refined per segment."""
import numpy as np

from firevoice import align
from firevoice.types import Word

W = [Word("hello", 0.1, 0.4), Word("2026", 0.45, 0.9), Word("there", 1.0, 1.3)]


def test_off_and_failures_keep_whisper_times(monkeypatch):
    a = np.zeros(16000 * 2, np.float32)
    monkeypatch.setenv("FIREVOICE_ALIGN", "off")
    assert align.refine(a, 16000, W) is W
    monkeypatch.setenv("FIREVOICE_ALIGN", "on")
    monkeypatch.setattr(align, "_load", lambda: (_ for _ in ()).throw(RuntimeError("no model")))
    assert align.refine(a, 16000, W) == W


def test_tokens_skip_digits():
    labels = {c: i for i, c in enumerate("-|ETAONIHSRDLUMWCFGYPBVK'XJQZ")}
    assert align._tokens("2026", labels) == "" and align._tokens("don't", labels) == "DON'T"


def test_segments_shift_back(monkeypatch):
    calls = []

    def fake(part, sr, local, offset=0.0):
        calls.append((len(part) / sr, offset, [w.start for w in local]))
        return [Word(w.text, w.start + 0.05 + offset, w.end + 0.05 + offset) for w in local]
    monkeypatch.setattr(align, "refine", fake)
    words = [Word("a", 1.0, 1.2), Word("b", 5.0, 5.3)]
    segs = [{"start": 0.9, "end": 1.3, "words": [0]}, {"start": 4.9, "end": 5.4, "words": [1]}]
    out = align.refine_segments(np.zeros(16000 * 6, np.float32), 16000, words, segs)
    assert [round(w.start, 2) for w in out] == [1.05, 5.05]
    assert abs(calls[1][1] - 4.6) < 1e-6 and abs(calls[1][2][0] - 0.4) < 1e-6
