"""Urdu: Roman Urdu scripts checked against Urdu-script transcripts by consonant skeleton; transcripts in English letters."""
import numpy as np

from firevoice import urdu

SCRIPT = "\u0622\u062c \u06a9\u0627 \u0645\u0648\u0633\u0645 \u0628\u06c1\u062a \u0627\u0686\u06be\u0627 \u06c1\u06d2"   # "aaj ka mausam bohat acha hai"


def test_skeleton_ignores_spelling_but_not_words():
    assert urdu.match("Aaj ka mausam bohat acha hai", SCRIPT) > 0.85
    assert urdu.match("Aaj ka mausam bohot achha hay", "aaj ka mosam bahut acha hai") > 0.95
    assert urdu.match("Kal subah das baje meeting hai", SCRIPT) < 0.5


def test_to_roman_uses_english_letters_only():
    r = urdu.to_roman(SCRIPT)
    assert r and all(ord(c) < 128 for c in r)
    assert not urdu.is_urdu_script(r) and urdu.is_urdu_script(SCRIPT)


def test_urdu_takes_are_checked(make):
    """With a validating aligner, Urdu passages are checked against what is heard in Urdu."""
    from firevoice.types import Word

    class FakeUrduAligner:
        validating = True
        model_name = "fake"

        def transcribe(self, audio, sr, text="", language=None):
            assert language == "ur"
            return [Word(w, 0.1 * i, 0.1 * i + 0.08) for i, w in enumerate(SCRIPT.split())]
    s = make(workers=1)
    s.aligner = FakeUrduAligner()
    good = s.speak("Aaj ka mausam bohat acha hai.", lang="ur")
    assert all(t.score > 0.8 for t in good.takes) and good.words and all(ord(c) < 128 for w in good.words for c in w.text)
    bad = s.speak("Kal subah das baje meeting hai.", lang="ur")
    assert all(t.score < 0.8 and not t.validated for t in bad.takes)
