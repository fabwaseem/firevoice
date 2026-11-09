from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Segment:
    """A run of text spoken in one style."""
    text: str
    style: str = "neutral"
    pace: float = 1.0


@dataclass
class Pause:
    ms: int


@dataclass
class Take:
    """One generated chunk and how it was validated."""
    text: str
    spoken: str
    seed: int
    score: float
    attempts: int
    duration: float
    validated: bool
    cached: bool = False


@dataclass
class Result:
    audio: np.ndarray
    sr: int
    words: list[Word] = field(default_factory=list)
    takes: list[Take] = field(default_factory=list)
    voice: str = "default"
    warnings: list[str] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return len(self.audio) / self.sr if self.sr else 0.0


class Cancelled(Exception):
    """A render was cancelled by its caller (job cancel, client disconnect)."""
