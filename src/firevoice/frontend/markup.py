"""SSML-lite markup, designed to be pleasant to type.

    [pause 600ms]       explicit silence (also: [pause 1.2s])
    [style excited]     switch delivery preset from here on (see styles.py)
    [pace 0.95]         speaking-rate multiplier from here on (0.8 - 1.2)
    blank line          paragraph break (long pause)

Everything else is spoken text.
"""
from __future__ import annotations

import re
from typing import Union

from ..types import Pause, Segment

_DIRECTIVE = re.compile(r"\[(pause|style|pace)\s+([^\]]+)\]", re.I)
# delivery tags: shorthand for a style switch that lasts until [normal] (or another tag / [style ...])
DELIVERY_TAGS = {"whisper": "asmr", "whispering": "asmr", "excited": "excited", "calm": "calm", "sad": "sad", "angry": "angry",
                 "serious": "serious", "dramatic": "dramatic", "curious": "curious", "deadpan": "deadpan", "storytelling": "storyteller"}
_DELIVERY = re.compile(r"\[(%s|normal)\]" % "|".join(DELIVERY_TAGS), re.I)


def _ms(arg: str) -> int:
    a = arg.strip().lower()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(ms|s)?", a)
    if not m:
        raise ValueError(f"bad pause value: {arg!r}")
    v = float(m.group(1))
    return int(round(v if m.group(2) == "ms" else v * 1000)) if m.group(2) else int(round(v))


def parse(text: str, default_style: str = "neutral", default_pace: float = 1.0) -> list[Union[Segment, Pause]]:
    # delivery tags become style directives ([normal] goes back to the request's own style)
    text = _DELIVERY.sub(lambda m: f"[style {default_style if m.group(1).lower() == 'normal' else DELIVERY_TAGS[m.group(1).lower()]}]", text or "")
    items: list[Union[Segment, Pause]] = []
    style, pace = default_style, default_pace
    pos = 0

    def emit(chunk: str) -> None:
        # paragraph breaks become pauses; the rest is speech
        parts = re.split(r"\n\s*\n", chunk)
        for i, part in enumerate(parts):
            body = " ".join(part.split())
            if body:
                items.append(Segment(body, style, pace))
            if i < len(parts) - 1:
                items.append(Pause(750))

    for m in _DIRECTIVE.finditer(text):
        emit(text[pos:m.start()])
        kind, arg = m.group(1).lower(), m.group(2)
        if kind == "pause":
            items.append(Pause(_ms(arg)))
        elif kind == "style":
            style = arg.strip().lower()
        else:
            pace = max(0.7, min(1.3, float(arg)))
        pos = m.end()
    emit(text[pos:])
    return items
