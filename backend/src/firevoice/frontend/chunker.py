"""Split text into sentence-sized chunks the model handles well, and decide the
silence that should follow each one."""
from __future__ import annotations

import re

_ABBR = ("mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "a.m", "p.m", "u.s", "no", "fig")
_SPLIT = re.compile(r"(?<=[.!?…])[\"')\]]*\s+(?=[\"'(\[]?(?:[A-Z0-9]|[^\x00-\x7f]))")
# sentence ends in scripts without capital letters: Urdu/Arabic full stop and question mark, Devanagari danda, CJK
_SPLIT_INTL = re.compile(r"(?<=[۔؟।॥。？！])\s*")
_END_STOP = ("۔", "।", "॥", "。")
_END_Q = ("؟", "？")


def split_sentences(text: str) -> list[str]:
    parts = [q for p in _SPLIT.split(text.strip()) for q in _SPLIT_INTL.split(p)]
    out: list[str] = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if out and re.search(r"(?:^|\s)(" + "|".join(re.escape(a) for a in _ABBR) + r")\.$", out[-1], re.I):
            out[-1] += " " + p
        else:
            out.append(p)
    return out


def gap_after_ms(chunk: str) -> int:
    """Natural silence after a chunk, by its closing punctuation."""
    c = chunk.rstrip("\"')] ")
    if c.endswith(("...", "…")):
        return 480
    if c.endswith("?") or c.endswith(_END_Q):
        return 340
    if c.endswith("!") or c.endswith("！"):
        return 280
    if c.endswith(".") or c.endswith(_END_STOP):
        return 300
    if c.endswith(":") or c.endswith(";"):
        return 240
    if c.endswith(","):
        return 160
    return 220


def make_chunks(text: str, min_chars: int = 28, max_chars: int = 260) -> list[str]:
    """Sentences, merged when too short (very short utterances make models
    hallucinate or sound clipped) and split on clauses when too long."""
    sents = split_sentences(text)
    merged: list[str] = []
    for s in sents:
        if merged and len(merged[-1]) < min_chars:
            merged[-1] += " " + s
        else:
            merged.append(s)
    if len(merged) > 1 and len(merged[-1]) < min_chars:
        tail = merged.pop()
        merged[-1] += " " + tail

    out: list[str] = []
    for s in merged:
        if len(s) <= max_chars:
            out.append(s)
            continue
        cur = ""
        for clause in re.split(r"(?<=[,;:])\s+", s):
            if cur and len(cur) + len(clause) + 1 > max_chars:
                out.append(cur)
                cur = clause
            else:
                cur = (cur + " " + clause).strip()
        if cur:
            out.append(cur)
    return out
