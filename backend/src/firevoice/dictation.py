"""Live dictation: speech in as it is spoken, text out as soon as it is certain.

The microphone's audio arrives in small pieces. Every few hundred milliseconds the part that is not settled yet is
transcribed again, and a word is released ("committed") once two passes in a row agree on it: the newest words of
any pass are a guess that the next half second of sound often changes, so they are shown as tentative and never
released. A released word is final: nothing sent to the caller is ever taken back, which is what lets a client type
the text straight into another program.

    live = LiveTranscriber(transcribe)          # transcribe: see Transcribe below
    live.feed(samples)                          # float32, 16 kHz mono, any chunk size, from any thread
    ev = live.step()                            # None, or {"commit": new text, "text": all of it, "tentative": guess}
    ev = live.finish()                          # the rest, once the speaker stops

The text that goes out is cleaned on the way: filler sounds (um, uh) are dropped, and "new line" / "new paragraph"
become line breaks. Both are optional.
"""
from __future__ import annotations

import re
import threading
from typing import Callable, Optional

import numpy as np

SR = 16000
# (words, language): words are (text, start seconds, end seconds) within the audio given
Transcribe = Callable[..., tuple[list[tuple[str, float, float]], Optional[str]]]

MIN_NEW = 0.30          # seconds of new sound before another pass is worth it
MAX_WINDOW = 26.0       # the model hears at most 30 s: beyond this the oldest words are released as they are
KEEP_SETTLED = 6.0      # once this much settled sound sits at the front of the window, it is cut away...
CONTEXT = 1.0           # ...except its last second, which the model keeps hearing as context
# languages that sound (nearly) the same when spoken and differ mostly in how they are written: the detector cannot tell
# them apart from a few seconds of speech, so they count as one and the speaker's own choice (or habit) picks the script
SIBLINGS = (("ur", "hi"), ("ms", "id"), ("no", "nn"), ("bs", "hr", "sr"))
PRIOR_FLOOR = 0.15      # automatic, no list: a language never dictated in before weighs this much against the history


def merge_siblings(probs: list, allowed: Optional[list], prior: Optional[dict]) -> list:
    """Put each group of spoken siblings together under the member the speaker writes: the one in their list, else the
    one their history uses most, else the likeliest."""
    out = dict(probs)
    for group in SIBLINGS:
        present = [c for c in group if c in out]
        if len(present) < 2 and not (present and allowed and present[0] not in allowed):
            continue
        mass = sum(out.get(c, 0.0) for c in group)
        mine = [c for c in group if allowed and c in allowed]
        if mine:
            keep = mine[0]
        elif prior and any(prior.get(c) for c in group):
            keep = max(group, key=lambda c: prior.get(c, 0.0))
        else:
            keep = max(present, key=lambda c: out.get(c, 0.0))
        for c in group:
            out.pop(c, None)
        out[keep] = mass
    return sorted(out.items(), key=lambda t: -t[1])


UNSURE_P = 0.5          # a guess less sure than this, before the language is settled, gives way to the speaker's habits
SURE_P = 0.9            # at the end, a language less sure than this is put to the test (both ways, the better kept)
LOCK_P = 0.75           # automatic language: settled once this sure (among the speaker's languages)...
LOCK_AFTER = 4.0        # ...or after this much sound, whichever comes first
RECHECK_P = 0.6         # at the end, the whole dictation overrules the early guess when it is at least this sure
SILENCE_RMS = 0.0025    # below this a stretch is silence: nothing to transcribe (and nothing for the model to invent)

from .dictation_text import FILLERS as _FILLERS, PhraseRules, format_words, norm as _norm  # noqa: F401  (format_words: public here too)

_PUNCT = ".,;:!?…"     # closing punctuation the model adds when the sound stops, whether or not the sentence has


class LiveTranscriber:
    def __init__(self, transcribe: Transcribe, language: Optional[str] = None, keyterms: Optional[list] = None,
                 commands: bool = True, fillers: bool = True, refine: bool = False, rules: Optional[PhraseRules] = None,
                 finalize: Optional[Callable[[str], str]] = None, languages: Optional[list] = None,
                 detect: Optional[Callable[[np.ndarray], list]] = None, prior: Optional[dict] = None,
                 scored: Optional[Callable[..., tuple]] = None):
        """language=None detects it from the first second and a half of speech, then keeps it. refine=True makes
        finish() transcribe a short dictation once more as a whole (more accurate; for clients that insert the text
        only at the end, since it may differ from what was released along the way). rules: the spoken phrases to act on
        (commands, punctuation, your replacements and snippets; dictation_text.PhraseRules). finalize: what the whole
        text goes through at the end (corrections said out loud, the writing model), for those same clients.

        Automatic language (language=None): `languages` are the ones the speaker uses (None: any). `detect` gives the
        probability of each language for some sound (asr.detect_language); while the language is not settled, every
        pass is made in the likeliest of the speaker's languages, and it is settled once it is clear (LOCK_P) or after
        LOCK_AFTER seconds of sound. With refine, the whole dictation is checked once more at the end, and a wrong early
        guess is put right before anything is inserted."""
        self._transcribe = transcribe
        self.allowed = [str(x) for x in (languages or []) if str(x).strip()] or None
        if not language and self.allowed and len(self.allowed) == 1:
            language = self.allowed[0]                   # one language: nothing to detect
        self.language = language or None
        self.fixed = self.language is not None           # chosen by the speaker: never changed
        self._detect = detect
        self.prior = {str(k): float(v) for k, v in (prior or {}).items()}   # share of past dictations, per language
        self._scored = scored
        self.language_probability: Optional[float] = None
        self.hotwords = ", ".join(str(k).strip() for k in (keyterms or []) if str(k).strip())[:800] or None
        self.commands, self.fillers, self.refine = commands, fillers, refine
        self.rules = rules if rules is not None else PhraseRules.build(commands=commands, punctuation=commands)
        self.finalize = finalize
        self._lock = threading.Lock()
        self._audio = np.zeros(0, dtype=np.float32)      # the window: sound from _start on
        self._whole: Optional[np.ndarray] = np.zeros(0, dtype=np.float32) if refine else None   # everything, while short
        self._start = 0.0                                # stream time of the window's first sample
        self._settled = 0.0                              # stream time up to which words are released
        self._seen = 0                                   # window length at the last pass
        self._guess: list[str] = []                      # the last pass's unreleased words, normalised
        self._words: list[str] = []                      # released words, as the model wrote them
        self._tail: list[tuple[str, float]] = []         # released words still inside the window: (normalised, end time)
        self._held: Optional[tuple[int, str]] = None     # (index in _words, punctuation) kept back from the newest word
        self._sent = ""                                  # text given out so far
        self._lang_guess: Optional[str] = None           # automatic language: the best guess while it is not settled
        self.total = 0.0                                 # seconds of sound received

    # -- audio in ------------------------------------------------------------
    def feed(self, samples: np.ndarray) -> None:
        a = np.asarray(samples, dtype=np.float32).reshape(-1)
        if not len(a):
            return
        with self._lock:
            self._audio = np.concatenate([self._audio, a])
            self.total += len(a) / SR
            if self._whole is not None:                  # kept only while the dictation is short enough to refine
                self._whole = np.concatenate([self._whole, a]) if self.total <= MAX_WINDOW else None

    # -- text out ------------------------------------------------------------
    def _release(self, words: list[str], final: bool = False) -> str:
        """Add released words; -> the new text they add (never anything that changes what was already given out)."""
        self._words += words
        text = format_words(self._words, self.commands, self.fillers, final=final, rules=self.rules)
        if not text.startswith(self._sent):              # cannot happen by construction; never retract regardless
            keep = 0
            while keep < min(len(text), len(self._sent)) and text[keep] == self._sent[keep]:
                keep += 1
            text = self._sent + text[keep:]
        delta, self._sent = text[len(self._sent):], text
        return delta

    def _pass(self, beam: int) -> tuple[list[tuple[str, float, float]], Optional[str]]:
        """Transcribe the window; -> (its words that are not released yet, in stream time; how this pass wrote the
        last released word, or None when it did not hear it)."""
        with self._lock:
            audio, start = self._audio, self._start
            self._seen = len(audio)
        fresh = audio[max(0, int((self._settled - start) * SR)):]
        if len(fresh) < SR // 10 or float(np.sqrt(np.mean(np.square(fresh)))) < SILENCE_RMS:
            return [], None
        # context for the model: what was said before the window (the window's own words it hears for itself)
        before = self._words[: len(self._words) - len(self._tail)]
        prompt = format_words(before, self.commands, self.fillers, rules=self.rules)[-200:].strip() or None
        use = self._settle_language(audio)
        words, lang = self._transcribe(audio, language=use, prompt=prompt, hotwords=self.hotwords, beam=beam)
        if self.language is None and self._detect is None and lang and len(audio) >= int(1.5 * SR):
            if self.allowed is None or lang in self.allowed:     # without a detector: the model's own guess, if it is one of yours
                self.language = lang
        heard = [(w, s + start, e + start) for w, s, e in words if w.strip()]
        j = self._split(heard)
        last = heard[j - 1][0] if j and self._tail and _norm(heard[j - 1][0]) == self._tail[-1][0] else None
        return heard[j:], last

    def _ranked(self, audio: np.ndarray) -> list[tuple[str, float]]:
        """The speaker's likeliest languages for this sound, most likely first, renormalised among the candidates."""
        if self._detect is None:
            return []
        probs = merge_siblings(self._detect(audio), self.allowed, self.prior)
        if self.allowed:
            probs = [(c, p) for c, p in probs if c in self.allowed]
        elif self.prior:
            probs = [(c, p * (PRIOR_FLOOR + self.prior.get(c, 0.0))) for c, p in probs]
        total = sum(p for _, p in probs)
        return sorted(((c, p / total) for c, p in probs), key=lambda t: -t[1]) if total > 0 else []

    def _which_language(self, audio: np.ndarray) -> Optional[tuple[str, float]]:
        """The likeliest of the speaker's languages for this sound, and how sure (renormalised among theirs).

        Spoken siblings (Urdu and Hindi above all) count as one language, written the way the speaker writes it.
        With no list of languages, the speaker's history weighs in: a language they have dictated in before needs far
        less evidence than one they never used, because a few seconds of speech are too little to tell 100 apart."""
        if self._detect is None:
            return None
        probs = merge_siblings(self._detect(audio), self.allowed, self.prior)
        if self.allowed:
            probs = [(c, p) for c, p in probs if c in self.allowed]
        elif self.prior:
            probs = [(c, p * (PRIOR_FLOOR + self.prior.get(c, 0.0))) for c, p in probs]
        total = sum(p for _, p in probs)
        if not probs or total <= 0:
            return None
        best = max(probs, key=lambda t: t[1])
        return best[0], best[1] / total

    def _settle_language(self, audio: np.ndarray) -> Optional[str]:
        """The language for this pass: the chosen or settled one; else the current best guess (settled once clear)."""
        if self.language is not None:
            return self.language
        if len(audio) < int(0.8 * SR):
            return self._lang_guess
        g = self._which_language(audio)
        if g is None:
            return self._lang_guess
        guess, p = g
        if p < UNSURE_P and self.prior and not self.allowed:
            # a second of sound says little: lean on the languages the speaker uses until the sound says more
            guess = max(self.prior, key=self.prior.get)
        self._lang_guess = guess
        if (p >= LOCK_P and self.total >= 1.5) or self.total >= LOCK_AFTER:
            self.language, self.language_probability = g
        return self._lang_guess

    def _settle_held(self, last: Optional[str]) -> None:
        """Words now follow the word whose punctuation was kept back: give it the punctuation this pass wrote for it
        (a full stop written at a pause is often gone, or a comma, once the sentence goes on)."""
        if self._held is None:
            return
        i, punct = self._held
        if last is not None:
            punct = last[len(last.rstrip(_PUNCT)):]
        self._words[i] += punct
        self._held = None

    def _hold(self, words: list[str]) -> list[str]:
        """The newest word heard is about to be released: keep its closing punctuation back until more is said."""
        bare = words[-1].rstrip(_PUNCT)
        if bare and bare != words[-1]:
            self._held = (len(self._words) + len(words) - 1, words[-1][len(bare):])
            return words[:-1] + [bare]
        return words

    def _split(self, heard: list[tuple[str, float, float]]) -> int:
        """Where the released words end in a pass over the window. Found by text: the last released words are looked
        up in what the pass heard. Word times shift a little from pass to pass, so going by time alone would now and
        then drop a word or say one twice; time only decides between equal matches, and when the text is not found."""
        by_time = sum(1 for _, s, e in heard if (s + e) / 2 <= self._settled)
        keys = [_norm(w) for w, _, _ in heard]
        tail = [k for k, _ in self._tail][-4:]
        for k in range(len(tail), 0, -1):
            want = tail[-k:]
            hits = [j for j in range(k, len(keys) + 1) if keys[j - k:j] == want and abs(j - by_time) <= 3]
            if hits:
                return min(hits, key=lambda j: abs(j - by_time))
        return by_time

    def _trim(self) -> None:
        """Cut settled sound from the front of the window so each pass stays short."""
        with self._lock:
            end = self._start + len(self._audio) / SR
            keep_from = self._start
            if self._settled - self._start > KEEP_SETTLED:
                keep_from = self._settled - CONTEXT
            elif not self._guess and end - max(self._settled, self._start) > 4.0:
                keep_from = end - 1.0                    # a long silence: keep its last second
            cut = int((keep_from - self._start) * SR)
            if cut > 0:
                self._audio = self._audio[cut:]
                self._start += cut / SR
                self._seen = max(0, self._seen - cut)
            self._settled = max(self._settled, self._start)
            self._tail = [(k, e) for k, e in self._tail if e > self._start + 0.05]

    def step(self) -> Optional[dict]:
        """One pass, if there is enough new sound. -> None, or {"commit", "text", "tentative"}."""
        with self._lock:
            if len(self._audio) - self._seen < int(MIN_NEW * SR):
                return None
            window = len(self._audio) / SR
        cand, last = self._pass(beam=1)
        keys = [_norm(w) for w, _, _ in cand]
        agree = 0
        while agree < min(len(keys), len(self._guess)) and keys[agree] == self._guess[agree]:
            agree += 1
        if self.language is None and self._detect is not None and not self.refine:
            agree = 0           # live: nothing is typed until the language is settled (words in a wrong one cannot be taken back)
        if window > MAX_WINDOW and len(cand) - agree > 2:
            agree = len(cand) - 2                        # the window is full: let go of all but the newest words
        delta = ""
        if agree:
            self._settle_held(last)
            out = [w for w, _, _ in cand[:agree]]
            delta = self._release(self._hold(out) if agree == len(cand) else out)
            self._settled = cand[agree - 1][2]
            self._tail += [(_norm(w), e) for w, _, e in cand[:agree]]
        self._guess = keys[agree:]
        self._trim()
        tentative = " ".join(w for w, _, _ in cand[agree:])
        if not delta and not tentative and not self._sent:
            return None
        return {"commit": delta, "text": self._sent, "tentative": tentative}

    def finish(self) -> dict:
        """The speaker stopped: release everything. -> {"commit", "text", "replace"}; replace=True means "text" was
        transcribed again as a whole and is the better version of all that was given out (refine)."""
        if self._whole is not None and len(self._whole) >= SR // 3:
            if float(np.sqrt(np.mean(np.square(self._whole)))) >= SILENCE_RMS:
                if not self.fixed and self._detect is not None:
                    # the whole dictation says more about its language than its first seconds did
                    g = self._which_language(self._whole)
                    if g is not None and (self.language is None or (g[0] != self.language and g[1] >= RECHECK_P)):
                        self.language, self.language_probability = g
                words = self._settle_by_score()
                if words is None:
                    words, lang = self._transcribe(self._whole, language=self.language, prompt=None, hotwords=self.hotwords, beam=5)
                    self.language = self.language or lang
                text = format_words([w for w, _, _ in words if w.strip()], self.commands, self.fillers, final=True, rules=self.rules)
                return self._finished(text, self._sent, refined=True)
        cand, last = self._pass(beam=3)
        self._settle_held(last if cand else None)
        before = self._sent
        self._release([w for w, _, _ in cand], final=True)
        self._guess = []
        return self._finished(self._sent, before, refined=False)

    def _settle_by_score(self) -> Optional[list]:
        """A short dictation whose language is still in doubt between two of the speaker's: transcribe it in the other
        one too and keep the version the speech model is more confident of (speech written in the wrong language,
        or translated into it, scores clearly lower). -> the words to keep, or None when there is no doubt (then the
        usual final pass is made)."""
        if self.fixed or self._scored is None or self._whole is None:
            return None
        ranked = self._ranked(self._whole)
        if len(ranked) < 2 or ranked[0][1] >= SURE_P or ranked[1][1] < 0.05:
            return None
        best = None
        for code, _ in ranked[:2]:
            w, _, score = self._scored(self._whole, language=code, prompt=None, hotwords=self.hotwords, beam=5)
            if best is None or score > best[2]:
                best = (w, code, score)
        if best is None:
            return None
        self.language = best[1]
        return best[0]

    def _finished(self, text: str, before: str, refined: bool) -> dict:
        """The last event: the whole text through `finalize` (when set). replace=True: "text" is the better version of
        everything given out, for a client that inserts only at the end."""
        out = text
        if self.finalize is not None and text.strip():
            try:
                out = self.finalize(text) or text
            except Exception:  # noqa: BLE001  (a failing polish never costs the dictation)
                import logging
                logging.getLogger("firevoice").exception("dictation: the final touch failed; the plain text is used")
                out = text
        delta = out[len(before):] if out.startswith(before) else ""
        replace = refined or out != text
        self._sent = out
        return {"commit": delta, "text": out, "tentative": "", "replace": replace}
