"""ASR used for two jobs: (1) catch bad takes (skipped/garbled/hallucinated words) by comparing what was
*said* with what was *asked*, and (2) produce exact word timestamps for captions.

GPU first: faster-whisper (CTranslate2) in float16 on CUDA, using the CUDA runtime DLLs that ship inside
the torch wheel on Windows. Falls back to CPU int8 when CUDA is unavailable. One model serves several
threads (CTranslate2 is thread-safe); `concurrency` bounds the simultaneous transcriptions.
"""
from __future__ import annotations

import difflib
import os
import re
import threading
from typing import Optional, Protocol

import numpy as np

from .types import Word


class Aligner(Protocol):
    validating: bool

    def transcribe(self, audio: np.ndarray, sr: int, text: str = "", language: Optional[str] = None) -> list[Word]: ...


class NullAligner:
    """No validation: spreads words evenly. Only for tests / when ASR is unavailable."""
    validating = False
    model_name = "null"
    device = "cpu"

    def __init__(self, text_hint: Optional[str] = None):
        pass

    def transcribe_window(self, audio: np.ndarray, language: Optional[str] = None, prompt: Optional[str] = None,
                          hotwords: Optional[str] = None, beam: int = 1) -> tuple[list[tuple[str, float, float]], Optional[str]]:
        return [], language

    def transcribe(self, audio: np.ndarray, sr: int, text: str = "", language: Optional[str] = None) -> list[Word]:
        words = text.split()
        if not words:
            return []
        dur = len(audio) / sr
        step = dur / len(words)
        return [Word(w, i * step, (i + 1) * step) for i, w in enumerate(words)]


def _cuda_dll_dir() -> None:
    if os.name != "nt":
        return
    try:
        import torch
        lib = os.path.join(os.path.dirname(torch.__file__), "lib")
        if os.path.isdir(lib):
            os.add_dll_directory(lib)
    except Exception:
        pass


def cuda_available() -> bool:
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def _resample16k(a: np.ndarray, sr: int) -> np.ndarray:
    if sr == 16000:
        return a.astype(np.float32, copy=False)
    n = int(len(a) * 16000 / sr)
    return np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)


class FasterWhisperAligner:
    validating = True

    def __init__(self, model: str = "auto", device: str = "auto", compute_type: Optional[str] = None, concurrency: int = 2, language: Optional[str] = "en",
                 model_instance=None):
        """language=None detects the language per file (STT). model_instance shares an already-loaded WhisperModel
        (one copy on the GPU serves validation and STT in every language)."""
        _cuda_dll_dir()
        # CTranslate2's default caching allocator keeps growing with varied input lengths and never gives VRAM
        # back; the async allocator returns it to the driver so TTS workers on the same card are not squeezed out.
        os.environ.setdefault("CT2_CUDA_ALLOCATOR", "cuda_malloc_async")
        from faster_whisper import WhisperModel
        if device == "auto":
            device = "cuda" if cuda_available() else "cpu"
        if model == "auto":
            model = "large-v3-turbo" if device == "cuda" else "base.en"
        if compute_type is None:
            compute_type = "float16" if device == "cuda" else "int8"
        self.model_name, self.device, self.language = model, device, language
        try:
            self.m = model_instance if model_instance is not None else WhisperModel(model, device=device, compute_type=compute_type)
        except Exception:
            if device != "cpu":  # no room on the GPU or a broken CUDA stack: fall back quietly
                self.model_name, self.device = ("base.en" if model == "large-v3-turbo" else model), "cpu"
                self.m = WhisperModel(self.model_name, device="cpu", compute_type="int8")
            else:
                raise
        self._sem = threading.BoundedSemaphore(max(1, concurrency))

    def transcribe(self, audio: np.ndarray, sr: int, text: str = "", language: Optional[str] = None) -> list[Word]:
        a = _resample16k(audio, sr)
        lang = language or self.language
        with self._sem:
            segs, _ = self.m.transcribe(a, word_timestamps=True, language=lang, beam_size=5 if lang == "ur" else 1, vad_filter=False,
                                        condition_on_previous_text=False)
            out: list[Word] = []
            for s in segs:
                for w in (s.words or []):
                    out.append(Word(w.word.strip(), float(w.start), float(w.end)))
        if lang == "en":
            from .align import refine
            out = refine(a, 16000, out)
        return out

    def transcribe_window(self, audio: np.ndarray, language: Optional[str] = None, prompt: Optional[str] = None,
                          hotwords: Optional[str] = None, beam: int = 1) -> tuple[list[tuple[str, float, float]], Optional[str]]:
        """One fast pass over a short stretch of 16 kHz speech, for live dictation (dictation.py): -> (words as
        (text, start, end), language). Built for speed: one decoding temperature, no retries, and silence is cut
        out first, which also keeps the model from inventing words where nobody spoke."""
        kw = {"initial_prompt": prompt} if prompt else {}
        if hotwords:
            kw["hotwords"] = hotwords
        args = dict(word_timestamps=True, language=language, beam_size=beam, temperature=0.0, condition_on_previous_text=False,
                    vad_filter=True, vad_parameters={"min_silence_duration_ms": 400, "speech_pad_ms": 200})
        with self._sem:
            try:
                segs, info = self.m.transcribe(audio, **args, **kw)
            except TypeError:                    # an older faster-whisper without hotwords
                kw.pop("hotwords", None)
                segs, info = self.m.transcribe(audio, **args, **kw)
            words = [(w.word.strip(), float(w.start), float(w.end)) for s in segs for w in (s.words or [])]
        return words, getattr(info, "language", language)

    def detect_language(self, audio: np.ndarray) -> list[tuple[str, float]]:
        """How likely each language is for a stretch of 16 kHz speech: [(code, probability)], most likely first.
        Silence is cut out first, so a pause does not dilute the guess."""
        if self.model_name.endswith(".en"):
            return [("en", 1.0)]
        with self._sem:
            try:
                _, _, probs = self.m.detect_language(audio=audio, vad_filter=True)
            except Exception:  # noqa: BLE001  (no speech left after the silence was cut, an older faster-whisper)
                return []
        return sorted(((str(c), float(p)) for c, p in probs), key=lambda t: -t[1])

    def transcribe_text(self, audio: np.ndarray, sr: int, beam_size: int = 3) -> tuple[str, list[Word]]:
        """Full STT: text plus word times (for `firevoice transcribe`)."""
        r = self.transcribe_full(audio, sr, beam_size=beam_size)
        return r["text"], r["words"]

    def transcribe_full(self, audio: np.ndarray, sr: int, beam_size: int = 5, language: Optional[str] = "__self__",
                        prompt: Optional[str] = None, hotwords: Optional[str] = None) -> dict:
        """-> {"text", "words": [Word], "segments": [{start, end, text, words: [i...]}], "language", "language_probability"};
        language=None detects it. `prompt` (context text) and `hotwords` (names and terms) steer the spelling."""
        a = _resample16k(audio, sr)
        lang = self.language if language == "__self__" else language
        kw = {}
        if prompt:
            kw["initial_prompt"] = prompt
        if hotwords:
            kw["hotwords"] = hotwords
        with self._sem:
            try:
                segs, info = self.m.transcribe(a, word_timestamps=True, language=lang, beam_size=beam_size, vad_filter=True, **kw)
            except TypeError:                    # an older faster-whisper without hotwords
                kw.pop("hotwords", None)
                segs, info = self.m.transcribe(a, word_timestamps=True, language=lang, beam_size=beam_size, vad_filter=True, **kw)
            words: list[Word] = []
            parts: list[str] = []
            segments: list[dict] = []
            for s in segs:
                parts.append(s.text.strip())
                first = len(words)
                for w in (s.words or []):
                    words.append(Word(w.word.strip(), float(w.start), float(w.end)))
                segments.append({"start": round(float(s.start), 3), "end": round(float(s.end), 3), "text": s.text.strip(),
                                 "words": list(range(first, len(words)))})
        if getattr(info, "language", lang) == "en":
            from .align import refine_segments
            words = refine_segments(a, 16000, words, segments)
        return {"text": " ".join(parts), "words": words, "segments": segments, "language": getattr(info, "language", lang),
                "language_probability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 3)}


_TOK = re.compile(r"[a-z0-9']+")


def tokens(s: str) -> list[str]:
    return _TOK.findall(s.lower().replace("-", " "))


def canon(s: str) -> list[str]:
    """Spoken-equivalence form so a correct take is not rejected for a spelling difference:
    'T T L' == 'TTL', 'one dot one' == '1.1' == 'one point one', 'hosts dot t x t' == 'hosts.txt', hyphens split,
    possessive 's dropped, a few homophones the ASR confuses merged."""
    t = s.lower().replace("-", " ").replace("%", " percent ").replace("&", " and ")
    t = re.sub(r"\s+([.,])(?=\w)", r"\1", t)          # whisper writes '1 .1 .1' and '86 ,142'
    t = _DECADE.sub(lambda m: f"{_CENT[m.group(1)]}{_DEC[m.group(2)]}s", t)   # nineteen seventies -> 1970s
    t = re.sub(r"\b(" + "|".join(_DEC) + r")\b", lambda m: f"{_DEC[m.group(1)]}s", t)  # the seventies -> 70s
    t = re.sub(r"(?<=[a-z])our(s?)\b", r"or\1", t)      # flavour/colours -> flavor/colors (both sides, so consistent)
    t = re.sub(r"(?<=[a-z])is(ation|ations|ing|ed|e|es)\b", r"iz\1", t)   # organisation/realise -> organization/realize
    t = re.sub(r"(?<=\d),(?=\d{3}\b)", "", t)          # 86,142 -> 86142
    t = re.sub(r"(?<=\w)\.(?=\w)", " dot ", t)         # 1.1.1.1, hosts.txt
    t = t.replace(" point ", " dot ")
    toks = _words_to_digits(_TOK.findall(t))
    out: list[str] = []
    run: list[str] = []
    for tok in toks + [""]:
        if len(tok) == 1 and tok not in ("a", "i") and not tok.isdigit():
            run.append(tok)
            continue
        if run:
            if len(run) == 1 and tok:
                out.append(run[0])
            else:
                out.append("".join(run))
            run = []
        if tok and tok != "and":
            tok = tok[:-2] if tok.endswith("'s") else tok.rstrip("'")
            out.append(HOMOPHONES.get(tok, tok))
    return out


HOMOPHONES = {"too": "to", "for": "four", "fore": "four", "their": "there", "they're": "there", "its": "it's", "ok": "okay", "ya": "you", "yeah": "yes",
              "route": "root", "routes": "roots", "cash": "cache", "cashed": "cached", "sight": "site", "cite": "site", "sites": "sites", "write": "right", "whole": "hole", "won": "1", "ate": "8"}
_DEC = {"twenties": 20, "thirties": 30, "forties": 40, "fifties": 50, "sixties": 60, "seventies": 70, "eighties": 80, "nineties": 90}
_CENT = {"eighteen": 18, "nineteen": 19, "twenty": 20}
_DECADE = re.compile(r"\b(eighteen|nineteen|twenty) (" + "|".join(_DEC) + r")\b")

_ONES = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split())}
_TENS = {w: i * 10 for i, w in enumerate("_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()) if w != "_"}
_SCALE = {"hundred": 100, "thousand": 1000, "million": 1_000_000, "billion": 1_000_000_000}
_NUMWORDS = set(_ONES) | set(_TENS) | set(_SCALE) | {"and", "oh"}


def _words_to_digits(toks: list[str]) -> list[str]:
    """'two thousand and forty nine' -> '2049'; 'twenty forty nine' (the year-style reading) -> '2049' too, so the
    script's wording and the recogniser's digits compare equal. Standalone digits are passed through."""
    out: list[str] = []
    i = 0
    while i < len(toks):
        digit_lead = toks[i].isdigit() and i + 1 < len(toks) and toks[i + 1] in _SCALE   # "8 billion"
        if (toks[i] not in _NUMWORDS or toks[i] == "and") and not digit_lead:
            out.append(toks[i])
            i += 1
            continue
        j = i
        groups: list[int] = []       # year-style groups ("twenty", "forty nine")
        total = cur = 0
        used_scale = False
        if digit_lead:
            cur = int(toks[i])
            j = i + 1
        while j < len(toks) and toks[j] in _NUMWORDS:
            w = toks[j]
            if w == "and":
                if j + 1 < len(toks) and toks[j + 1] in _NUMWORDS and (cur or total):
                    j += 1
                    continue
                break
            if w == "oh":
                w = "zero"
            if w in _ONES:
                if cur % 100 and _ONES[w] >= 10 and not used_scale:
                    groups.append(cur)
                    cur = 0
                cur += _ONES[w]
            elif w in _TENS:
                if cur % 100 >= 10 or (cur % 100 and cur % 10 == 0):
                    groups.append(cur)
                    cur = 0
                elif 0 < cur % 100 < 10 and not used_scale:
                    cur = cur * 100          # "one thirty two" -> 132
                cur += _TENS[w]
            else:
                used_scale = True
                if w == "hundred":
                    cur = (cur or 1) * 100
                else:
                    total += (cur or 1) * _SCALE[w]
                    cur = 0
            j += 1
        if groups and not used_scale and not total:
            groups.append(cur)
            if len(groups) == 2 and 10 <= groups[0] <= 99 and groups[1] < 100:
                out.append(str(groups[0] * 100 + groups[1]))
            else:
                out.extend(str(g) for g in groups)
        else:
            if groups:
                out.extend(str(g) for g in groups)
            out.append(str(total + cur))
        i = j
    return out


def match_score(asked: str, said: str) -> float:
    """0..1 similarity between the requested text and the transcript (word level, spoken-equivalent forms)."""
    a, b = canon(asked), canon(said)
    if not a:
        return 1.0
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    matched = 0
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            matched += 2 * (i2 - i1)
        elif op == "replace" and "".join(a[i1:i2]) == "".join(b[j1:j2]):
            matched += (i2 - i1) + (j2 - j1)   # 'lookup' vs 'look up', 'web site' vs 'website'
    return matched / (len(a) + len(b))
