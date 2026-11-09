import numpy as np

from firevoice import audio as A
from firevoice.core.adapters.base import strip_tags
from firevoice.synth import _seeded_jitter


def test_tags_are_stripped_for_engines_without_tags():
    assert strip_tags("Fine. [chuckle] Really fine. [sigh]") == "Fine. Really fine."
    assert strip_tags("[clear throat] Okay.") == "Okay."


def test_jitter_is_deterministic_and_bounded():
    xs = [_seeded_jitter(i) for i in range(200)]
    assert xs == [_seeded_jitter(i) for i in range(200)]
    assert all(0.85 <= x <= 1.15 for x in xs)
    assert len(set(round(x, 3) for x in xs)) > 50


def test_rms_match_levels_takes():
    sr = 24000
    quiet = 0.02 * np.sin(2 * np.pi * 220 * np.arange(sr) / sr).astype("float32")
    loud = 0.6 * np.sin(2 * np.pi * 220 * np.arange(sr) / sr).astype("float32")
    a, b = A.rms_match(quiet, sr), A.rms_match(loud, sr)
    ra, rb = np.sqrt((a ** 2).mean()), np.sqrt((b ** 2).mean())
    assert abs(20 * np.log10(ra / rb)) < 6


def test_candidates_and_pauses(make):
    s = make(candidates=2)
    r = s.speak("One two three four five six seven. Eight nine ten eleven twelve.", lufs=None, style="calm")
    assert len(r.takes) == 2 and all(t.attempts == 2 for t in r.takes)
    assert r.stats.takes == 4
    r2 = make().speak("One two three four five six seven. Eight nine ten eleven twelve.", lufs=None, style="excited")
    assert r.duration > r2.duration  # calm pauses longer, excited paces faster
