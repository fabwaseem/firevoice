"""Urdu in English letters: transliterate what Whisper hears (Urdu script) to Roman Urdu, and compare Roman Urdu texts.

FireVoice scripts write Urdu in Roman Urdu ("Aaj ka episode shuru karte hain"), whose spelling is not standardised:
"hain", "hen", "hein" are all the same word. Whisper writes Urdu in Urdu script. So a take is checked by reducing both
sides to a consonant skeleton: vowels, h-aspiration and doubled letters dropped, sound-alike letters merged. Spelling
variants then compare equal while a missing or wrong word still shows.

`to_roman` is a letter-by-letter transliteration for reading a transcript in English letters. It is approximate
(Urdu script leaves most short vowels unwritten), which is fine for following along and for the skeleton check.
"""
from __future__ import annotations

import difflib
import re

_MAP = {
    "ا": "a", "آ": "aa", "أ": "a", "إ": "i", "ب": "b", "پ": "p", "ت": "t", "ٹ": "t", "ث": "s", "ج": "j", "چ": "ch", "ح": "h", "خ": "kh",
    "د": "d", "ڈ": "d", "ذ": "z", "ر": "r", "ڑ": "r", "ز": "z", "ژ": "zh", "س": "s", "ش": "sh", "ص": "s", "ض": "z", "ط": "t", "ظ": "z",
    "ع": "", "غ": "gh", "ف": "f", "ق": "q", "ک": "k", "ك": "k", "گ": "g", "ل": "l", "م": "m", "ن": "n", "ں": "n", "و": "o", "ؤ": "o",
    "ہ": "h", "ھ": "h", "ه": "h", "ۃ": "t", "ة": "t", "ء": "", "ی": "i", "ي": "i", "ى": "i", "ئ": "", "ے": "e", "ۓ": "e",
    "۔": ".", "،": ",", "؟": "?", "؛": ";", "٪": "%",
}
_DIGITS = {chr(0x06F0 + i): str(i) for i in range(10)} | {chr(0x0660 + i): str(i) for i in range(10)}
_MARKS = re.compile("[ً-ٰٟۖ-ۭ]")      # harakat and Quranic marks: unwritten vowels
_URDU = re.compile("[؀-ۿ]")


def is_urdu_script(text: str) -> bool:
    return bool(_URDU.search(text or ""))


def to_roman(text: str) -> str:
    """Urdu script -> approximate Roman Urdu (Latin text passes through)."""
    t = _MARKS.sub("", text or "")
    out = []
    for ch in t:
        out.append(_MAP.get(ch, _DIGITS.get(ch, ch)))
    s = "".join(out)
    s = re.sub(r"\bo\b", "o", s)
    return re.sub(r"\s+", " ", s).strip()


_DIGRAPHS = [("kh", "k"), ("gh", "g"), ("sh", "s"), ("ch", "c"), ("zh", "z"), ("th", "t"), ("dh", "d"), ("bh", "b"), ("ph", "f"),
             ("jh", "j"), ("rh", "r"), ("q", "k"), ("v", "w"), ("x", "ks"), ("c", "c")]


def skeleton(text: str) -> str:
    """The consonants of a Roman (or transliterated) Urdu text, with spelling variation removed."""
    s = to_roman(text).lower() if is_urdu_script(text) else (text or "").lower()
    s = re.sub(r"[^a-z]", "", s)
    for a, b in _DIGRAPHS:
        s = s.replace(a, b)
    s = re.sub(r"[aeiouyhw']", "", s)
    return re.sub(r"(.)\1+", r"\1", s)


def match(asked_roman: str, heard: str) -> float:
    """0..1: how much of the asked Roman Urdu text was heard (skeleton similarity)."""
    a, b = skeleton(asked_roman), skeleton(heard)
    if not a:
        return 1.0
    return round(difflib.SequenceMatcher(None, a, b, autojunk=False).ratio(), 3)
