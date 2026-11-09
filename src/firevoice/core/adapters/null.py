"""Deterministic stand-in for tests and CI: a quiet tone whose length scales with the text."""
from __future__ import annotations

import time

import numpy as np

from .base import Adapter


class NullAdapter(Adapter):
    name = "null"
    sr = 24000
    needs_reference = False
    supports_tags = True
    supports_design = True
    license = "MIT"
    commercial = True
    vram_gb = 0.0

    def __init__(self, delay: float = 0.0, fail_on: str = "", stream: str = "", **kw):
        super().__init__(**kw)
        self.delay = float(delay)
        self.fail_on = fail_on
        self.supports_streaming = str(stream).lower() in ("1", "true", "yes")   # tests of the streaming path

    def _synth_stream(self, text, cond, params, seed):
        a = self._synth(text, cond, params, seed)
        step = self.sr // 10                    # 100 ms pieces, as a streaming decoder would hand them out
        for i in range(0, len(a), step):
            time.sleep(self.delay / 10 if self.delay else 0.005)
            yield a[i: i + step]

    def _load(self) -> None:
        self.device = "cpu"

    def _synth(self, text, cond, params, seed):
        if self.fail_on and self.fail_on in text:
            raise RuntimeError(f"null engine asked to fail on {self.fail_on!r}")
        if self.delay:
            time.sleep(self.delay)
        n = max(1, len(text.split()))
        dur = 0.06 + 0.32 * n * float(params.get("pace", 1.0))
        t = np.arange(int(self.sr * dur)) / self.sr
        env = np.minimum(1, t / 0.02) * np.minimum(1, (dur - t) / 0.02)
        return (0.2 * np.sin(2 * np.pi * (180 + seed % 40) * t) * env).astype(np.float32)
