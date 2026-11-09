"""Written text -> how a person would actually say it.

Raw TTS models guess at digits, symbols and acronyms and often get them wrong.
This pass makes the spoken form explicit and deterministic.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from num2words import num2words

# Words a speaker would spell out letter by letter, or pronounce specially.
DEFAULT_LEXICON: dict[str, str] = {
    "AI": "A I", "API": "A P I", "APIs": "A P Is", "PR": "P R", "PRs": "P Rs",
    "CI": "C I", "CD": "C D", "CLI": "C L I", "GUI": "G U I", "UI": "U I", "UX": "U X",
    "LLM": "L L M", "LLMs": "L L Ms", "GPU": "G P U", "CPU": "C P U", "TTS": "T T S",
    "ASR": "A S R", "SQL": "sequel", "JSON": "jason", "YAML": "yammel", "OSS": "O S S",
    "IDE": "I D E", "SDK": "S D K", "MCP": "M C P", "URL": "U R L", "HTML": "H T M L",
    "CSS": "C S S", "LUFS": "loofs", "FAQ": "F A Q", "CEO": "C E O", "EVP": "E V P",
    "GitHub": "Git Hub", "arXiv": "archive", "TypeScript": "Type Script",
    "JavaScript": "Java Script", "YouTube": "You Tube", "vs": "versus", "vs.": "versus",
    "e.g.": "for example", "i.e.": "that is", "etc.": "et cetera", "a.m.": "A M", "p.m.": "P M",
}

_MAG = {"k": "thousand", "K": "thousand", "m": "million", "M": "million", "b": "billion", "B": "billion", "t": "trillion", "T": "trillion"}


def _num_words(s: str) -> str:
    s = s.replace(",", "")
    if "." in s:
        whole, frac = s.split(".", 1)
        head = num2words(int(whole or 0))
        tail = " ".join(num2words(int(d)) for d in frac)
        return f"{head} point {tail}"
    return num2words(int(s))


def _year(n: int) -> str:
    return num2words(n, to="year")


def load_lexicon(path: Optional[str | Path] = None) -> dict[str, str]:
    lex = dict(DEFAULT_LEXICON)
    if path and Path(path).exists():
        lex.update(json.loads(Path(path).read_text(encoding="utf-8")))
    return lex


_LATIN = re.compile(r"[A-Za-z]")
_LETTER = re.compile(r"[^\W\d_]")


def is_english_text(text: str, lang: Optional[str] = None) -> bool:
    """English normalisation (numbers to English words, tech lexicon) only makes sense for English. Other
    languages keep their digits and words for the model to read natively."""
    if lang:
        return lang.lower().startswith("en")
    letters = _LETTER.findall(text)
    return not letters or len(_LATIN.findall(text)) / len(letters) > 0.7


def normalize(text: str, lexicon: Optional[dict[str, str]] = None, lang: Optional[str] = None) -> str:
    if not is_english_text(text, lang):
        return re.sub(r"\s+", " ", text).strip()
    lex = lexicon if lexicon is not None else DEFAULT_LEXICON
    t = text

    # symbols that change meaning
    t = t.replace("&", " and ").replace("→", " to ").replace("->", " to ")
    t = re.sub(r"\s*—\s*|\s+--\s+", ", ", t)

    # currency: $1.3B, $20, $4,500
    def money(m: re.Match) -> str:
        n, mag = m.group(1), m.group(2)
        out = _num_words(n)
        if mag:
            out += " " + _MAG[mag]
        return out + " dollars"
    t = re.sub(r"\$(\d[\d,]*(?:\.\d+)?)([kKmMbBtT])?\b", money, t)

    # percent, incl. "40%+" -> "forty percent or more"
    t = re.sub(r"(\d[\d,]*(?:\.\d+)?)\s?%\+", lambda m: _num_words(m.group(1)) + " percent or more", t)
    t = re.sub(r"(\d[\d,]*(?:\.\d+)?)\s?%", lambda m: _num_words(m.group(1)) + " percent", t)

    # magnitudes: 17.9B, 3.5M, 220M, 12k
    t = re.sub(r"\b(\d[\d,]*(?:\.\d+)?)([kKmMbBtT])\b", lambda m: _num_words(m.group(1)) + " " + _MAG[m.group(2)], t)

    # IP addresses: 1.1.1.1 -> one dot one dot one dot one (before the decimal rule turns the dots into "point")
    t = re.sub(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b", lambda m: " dot ".join(_num_words(g) for g in m.groups()), t)

    # ordinals: 3rd, 21st
    t = re.sub(r"\b(\d+)(st|nd|rd|th)\b", lambda m: num2words(int(m.group(1)), to="ordinal"), t)

    # ranges: 2025-2026, 3-5
    t = re.sub(r"\b(\d{1,4})\s?[-–]\s?(\d{1,4})\b", lambda m: f"{m.group(1)} to {m.group(2)}", t)

    # years (standalone 4-digit 1900-2099)
    t = re.sub(r"\b(19\d{2}|20\d{2})\b(?![.,]\d)", lambda m: _year(int(m.group(1))), t)

    # remaining numbers (with commas / decimals)
    t = re.sub(r"\b\d[\d,]*(?:\.\d+)?\b", lambda m: _num_words(m.group(0)), t)

    # lexicon (whole-word, case-sensitive)
    for k in sorted(lex, key=len, reverse=True):
        pat = r"(?<![A-Za-z0-9])" + re.escape(k) + r"(?![A-Za-z0-9])"
        t = re.sub(pat, lex[k], t)

    t = re.sub(r"[ \t]+", " ", t).strip()
    return t
