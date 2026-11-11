"""Download progress the way a person reads it: how much of how much, how fast, and how long still.

    meter = Speedometer("Downloading Flare")
    meter.text(done, total)   # "312 MB of 2.5 GB · 2.4 MB/s · about 15 min left"

The speed is measured over the last few seconds and smoothed, so it neither jumps around nor lags far behind a change
in the connection; until there is enough to go on, only the amounts are shown.
"""
from __future__ import annotations

import time
from typing import Optional


def size(n: float) -> str:
    if n >= 1e9:
        return f"{n / 1e9:.1f} GB"
    if n >= 1e6:
        return f"{n / 1e6:.0f} MB"
    return f"{max(0, n) / 1e3:.0f} KB"


def eta(seconds: float) -> str:
    if seconds < 60:
        return "less than a minute left"
    if seconds < 90 * 60:
        return f"about {round(seconds / 60)} min left"
    return f"about {seconds / 3600:.1f} h left"


class Speedometer:
    def __init__(self, label: str, window: float = 1.0):
        self.label, self.window = label, window
        self._t: Optional[float] = None
        self._d = 0.0
        self.bps = 0.0

    def rebase(self, done: float) -> None:
        """Bytes that arrived without being downloaded now (a resumed file, the next file of several): not speed."""
        self._t, self._d = time.monotonic(), done

    def update(self, done: float) -> float:
        """Feed the bytes done so far; -> the smoothed speed in bytes a second (0 until it is known)."""
        now = time.monotonic()
        if self._t is None:
            self._t, self._d = now, done
            return self.bps
        dt = now - self._t
        if dt >= self.window:
            inst = max(0.0, (done - self._d) / dt)
            self.bps = inst if not self.bps else self.bps * 0.7 + inst * 0.3
            self._t, self._d = now, done
        return self.bps

    def text(self, done: float, total: Optional[float]) -> str:
        self.update(done)
        # the numbers only: wherever this shows, the heading above it already says what is downloading
        if not total:
            return size(done) + (f" · {self.bps / 1e6:.1f} MB/s" if self.bps else "")
        msg = f"{size(min(done, total))} of {size(total)}"
        if self.bps > 0:
            msg += f" · {self.bps / 1e6:.1f} MB/s · {eta(max(0.0, total - done) / self.bps)}"
        return msg
