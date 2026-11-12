"""The wake phrase: say "Hey FireVoice" and a dictation starts, hands-free.

The desktop shell streams the microphone here while nothing else is listening (route /api/v1/wake). Most of what a
microphone hears is silence or other people, so the work is done in two steps:

1. a voice detector (Silero, as faster-whisper ships it) finds where speech starts, over the last few seconds;
2. only the opening of each stretch of speech (about two seconds) goes through the speech model, and the words are
   compared with the wake phrase, loosely ("hey fire voice", "hi firevoice", "okay fire voice", one sound off).

The phrase has to open what is said: "hey FireVoice" in the middle of a sentence to someone else does not count. On a
match the shell is told where in its stream the phrase ended, so the dictation starts with what came after it:
"Hey FireVoice, tell John I'm running late" works in one breath.
"""

from __future__ import annotations

import difflib
import re
from typing import Optional, Sequence

import numpy as np

SR = 16000
# the greeting, as the speech model writes it ("Hi" often comes out as "high", "Hey" as "hay")...
GREETINGS = frozenset({"hey", "hay", "hei", "heyy", "hi", "high", "hai", "okay", "ok", "kay"})
# ...then the name, compared without spaces or punctuation ("Fire Voice", "fire-voice", "FireVoice" are one), by
# spelling and by sound: accents move sounds the speech model then spells differently ("Fireboys", "Fairboys",
# "Firevoix" for FireVoice), so b/v/w are one sound, s/z/x another, and vowels only count as vowels
NAME = "firevoice"
CLOSE = 0.84           # by spelling: one letter or so off ("five voice", "fire vice")
CLOSE_SOUND = 0.9      # by sound, nearly the same: "fireboys", "fair voice", "firevoix"; not "fireboy", "forever"
CLOSE_LEARNED = 0.9    # a form taught by the user's own voice (Dictation, Teach it your voice)
# real words that sound close and are said to people ("Hey, Firefox is open"): never the name
NOT_NAMES = frozenset({"firefox", "firebase", "firework", "fireworks", "firewall", "firewalls", "forever", "firewood",
                       "fireplace", "fireball", "firebird", "firefly", "fireflies", "fairway", "fairways", "fairbanks"})

KEEP_S = 8.0           # audio kept for looking back
VAD_S = 4.0            # how far back the voice detector looks each time
LOOK_S = 2.6           # how much of a stretch of speech is transcribed to find the phrase
MIN_S = 0.35           # shorter than this is not the phrase
FIRST_S = 0.85         # a stretch still going on is first looked at when it is this long (about the phrase itself)...
AGAIN_S = 0.4          # ...and again each time this much more has come, until LOOK_S of it has been seen
LEAD_S = 0.15          # a little before the detected start, so the first sound is not clipped
STEP_S = 0.2           # how often the detector runs


def _letters(s: str) -> str:
    return re.sub(r"[^a-z]", "", s.lower())


def _sound(s: str) -> str:
    """A rough sound key: "firevoice", "fireboys", "fairvoyce" and "firevoix" all come out as "farvas"-like."""
    s = _letters(s).replace("ph", "f").replace("ck", "k")
    s = re.sub(r"c(?=[eiy])", "s", s).replace("c", "k")
    s = re.sub(r"[bvw]", "v", s)
    s = re.sub(r"[szx]", "s", s)
    s = re.sub(r"[aeiouy]+", "a", s)
    s = re.sub(r"(.)\1+", r"\1", s)
    return s.rstrip("a") or s


_NAME_SOUND = _sound(NAME)


def _close(name: str, learned: Sequence[str] = ()) -> float:
    """How surely these letters are the name: by spelling, by sound, or as the user's voice taught it. 0 if not."""
    if name in NOT_NAMES:
        return 0.0
    r = difflib.SequenceMatcher(None, name, NAME).ratio()
    if r >= CLOSE:
        return r
    snd = _sound(name)
    if len(snd) >= 4 and difflib.SequenceMatcher(None, snd, _NAME_SOUND).ratio() >= CLOSE_SOUND:
        return CLOSE_SOUND
    for form in learned:
        if difflib.SequenceMatcher(None, name, form).ratio() >= CLOSE_LEARNED:
            return CLOSE_LEARNED
    return 0.0


def _greeting_at(words: Sequence[tuple[str, float, float]]) -> list[tuple[int, str]]:
    """Where a greeting could open these words: [(index of the word after it, rest of a word it began)]."""
    out = []
    for first in range(0, min(2, len(words))):
        if first == 1 and len(_letters(words[0][0])) > 4:
            break                                          # only a short word may come before it
        g = _letters(words[first][0])
        if g in GREETINGS:
            out.append((first + 1, ""))
        else:
            # written as one word ("HeyFireVoice")
            pre = next((x for x in sorted(GREETINGS, key=len, reverse=True) if g.startswith(x) and len(g) > len(x) + 4), None)
            if pre:
                out.append((first + 1, g[len(pre):]))
    return out


def _names(words: Sequence[tuple[str, float, float]], k: int, lead: str):
    """The ways the name could run from words[k] (after `lead`): -> [(letters, end time)]."""
    out, joined = [], lead
    if lead:
        out.append((joined, float(words[k - 1][2])))
    for j in range(k, min(k + 3, len(words))):
        joined += _letters(words[j][0])
        if len(joined) > len(NAME) + 5:
            break
        out.append((joined, float(words[j][2])))
    return out


def match(words: Sequence[tuple[str, float, float]], learned: Sequence[str] = ()) -> Optional[float]:
    """The wake phrase at the start of these words (text, start, end in seconds)? -> where it ends, or None.

    A greeting ("hey", "hi", "okay") and then the name. It may follow one short word ("so, hey FireVoice", "uh, hey
    FireVoice") but must open what is said otherwise. `learned`: forms of the name the user's voice has taught."""
    best = None
    for k, lead in _greeting_at(words):
        for name, end in _names(words, k, lead):
            r = _close(name, learned)
            if r and (best is None or r > best[0]):
                best = (r, end)
        if best:
            return best[1]
    return None


def heard_name(text: str) -> Optional[str]:
    """Teaching: how the name came out in this attempt ("Hey Fireboys!" -> "fireboys"), if it opened with a greeting
    and something name-like followed; None for anything else (a cough, "voice", other words)."""
    words = [(w, float(i), float(i + 1)) for i, w in enumerate(text.split())]
    best = None
    for k, lead in _greeting_at(words):
        for name, _ in _names(words, k, lead):
            if not 5 <= len(name) <= len(NAME) + 5 or name in NOT_NAMES:
                continue
            r = difflib.SequenceMatcher(None, _sound(name), _NAME_SOUND).ratio()
            if r >= 0.6 and (best is None or r > best[0]):
                best = (r, name)
    return best[1] if best else None


class WakeSpotter:
    """One microphone stream, listened to for the wake phrase. feed() 16 kHz audio as it comes; step() now and then
    -> {"at": seconds into the stream where the phrase ended, "heard": the words} once it is said, else None."""

    def __init__(self, transcribe, vad=None, debug=None, learned: Sequence[str] = ()):
        """transcribe(audio) -> [(text, start, end)]: a fast English pass over a short stretch (the aligner's
        transcribe_window). vad(audio) -> [{"start", "end"}] in samples (faster-whisper's detector by default).
        debug(audio, heard, woke, start): told about every look (start: where its stretch of speech began), for
        teaching and tuning on a real voice. learned: forms of the name the user's voice has taught."""
        self._transcribe = transcribe
        self.learned = list(learned)
        self._vad = vad or _silero
        self._debug = debug
        self.buf = np.zeros(0, dtype=np.float32)
        self.base = 0                  # stream sample index of buf[0]
        self.handled = 0               # speech that starts before this sample has been looked at
        self._looking: tuple[int, float] | None = None    # the stretch being followed: (start, length last looked at)
        self._last_step = 0

    @property
    def now(self) -> int:
        return self.base + len(self.buf)

    def feed(self, audio: np.ndarray) -> None:
        self.buf = np.concatenate([self.buf, audio.astype(np.float32, copy=False)])
        extra = len(self.buf) - int(KEEP_S * SR)
        if extra > 0:
            self.buf = self.buf[extra:]
            self.base += extra

    def step(self) -> Optional[dict]:
        if self.now - self._last_step < int(STEP_S * SR):
            return None
        self._last_step = self.now
        start_of_window = max(self.base, self.now - int(VAD_S * SR))
        window = self.buf[start_of_window - self.base:]
        if len(window) < int(MIN_S * SR):
            return None
        for seg in self._vad(window):
            s, e = start_of_window + int(seg["start"]), start_of_window + int(seg["end"])
            ended = e < self.now - int(0.25 * SR)
            if s < self.handled:
                # already looked at: if it is still going on, keep it out of later looks
                if not ended:
                    self.handled = max(self.handled, self.now)
                continue
            # speech running back to the window's edge may have begun before it: not an opening, so not the phrase
            if s <= start_of_window + int(0.05 * SR) and start_of_window > self.base:
                self.handled = self.now if not ended else e
                continue
            length = (e - s) / SR
            if ended and length < MIN_S:
                self.handled = e
                continue
            same = self._looking is not None and abs(self._looking[0] - s) < int(0.3 * SR)
            if not ended:
                # the phrase can be heard before the stretch ends: look as soon as it could be complete, and again
                # as more comes (it may run on into the dictation, or start slowly)
                if length < FIRST_S or (same and length - self._looking[1] < AGAIN_S):
                    return None
            a = max(self.base, s - int(LEAD_S * SR))
            b = min(self.now, s + int(LOOK_S * SR))
            clip = self.buf[a - self.base: b - self.base]
            words = self._transcribe(clip)
            end = match(words, self.learned)
            if self._debug:
                try:
                    self._debug(clip, " ".join(w[0] for w in words).strip(), end is not None, s)
                except Exception:  # noqa: BLE001
                    pass
            if end is not None:
                self.handled, self._looking = self.now, None
                return {"at": (a + end * SR) / SR, "heard": " ".join(w[0] for w in words).strip()}
            if ended or length >= LOOK_S:
                self.handled, self._looking = (e if ended else self.now), None
            else:
                self._looking = (s, length)
            return None
        return None


_VAD_OPTS = None


def _silero(audio: np.ndarray) -> list[dict]:
    global _VAD_OPTS
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    if _VAD_OPTS is None:
        # a short pause ("hey ... FireVoice") stays one stretch; a breath between sentences ends it
        _VAD_OPTS = VadOptions(threshold=0.5, min_speech_duration_ms=150, min_silence_duration_ms=450, speech_pad_ms=60)
    return get_speech_timestamps(audio, _VAD_OPTS)
