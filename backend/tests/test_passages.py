"""Fewer seams, steadier voice: sentences are packed into one generation per passage, and a [pause] inside a passage is
generated through and cut in afterwards at the word boundary."""
import numpy as np

from firevoice.frontend import parse
from firevoice.styles import get_style
from firevoice.synth import WORD_RE, _Chunk
from firevoice.types import Pause, Word

SCRIPT = ("Hello! This is FireVoice, running entirely on your own GPU. [pause 400ms] Every sentence is rendered in parallel, "
          "checked by speech recognition, and mastered before you hear it.")


def _plan(s, text, budget, lang="en"):
    base = get_style("conversational")
    return s._plan(parse(text, "conversational", 1.0), base, None, lang, 1234, {"passage_chars": budget})


def test_sentence_mode_is_unchanged(make):
    s = make()
    chunks, plan = _plan(s, "Hello there, my good friend of many years. How are you feeling today, honestly? [pause 400ms] Fine, thanks so much for asking me.", 0)
    assert len(chunks) == 3
    assert isinstance(plan[2], Pause) and plan[2].ms == 400
    assert plan[0][1] > 0 and plan[1][1] == 0          # breath between sentences, none before an explicit pause


def test_passage_generates_through_the_pause(make):
    s = make()
    chunks, plan = _plan(s, SCRIPT, 360)
    assert len(chunks) == 1 and not any(isinstance(p, Pause) for p in plan)
    ch = chunks[0]
    assert ch.text.rstrip().endswith("hear it.")
    (nwords, ms), = ch.cuts
    before = ch.text[: ch.text.index("Every")]
    assert ms == 400 and nwords == len(WORD_RE.findall(before.lower()))   # the cut sits right before "Every"


def test_what_still_splits(make):
    s = make()
    long = " ".join(f"This is sentence number {w} of a fairly long passage about lighthouses." for w in
                    ["one", "two", "three", "four", "five", "six", "seven", "eight"])
    chunks, _ = _plan(s, long, 360)
    assert len(chunks) > 1 and all(len(c.text) <= 360 for c in chunks)
    chunks, plan = _plan(s, "Calm words for a start. [style excited] Now something thrilling happens!", 360)
    assert len(chunks) == 2                               # a style change is a new generation
    chunks, plan = _plan(s, "Assalam o Alaikum dosto. [pause 400ms] Aaj hum baat karenge.", 360, lang="ur")
    assert len(chunks) == 2 and any(isinstance(p, Pause) for p in plan)   # no word timings to cut by
    chunks, plan = _plan(s, "Wait. [pause 5s] Now go on.", 360)
    assert len(chunks) == 2                               # long silences stay real splits


def test_cut_replaces_the_natural_gap_with_the_requested_silence(make):
    s = make()
    sr = s.sr
    tone = lambda sec: (0.3 * np.sin(np.arange(int(sr * sec)) * 2 * np.pi * 200 / sr)).astype(np.float32)
    a = np.concatenate([tone(1.0), np.zeros(int(sr * 0.3), np.float32), tone(1.0)])
    # ASR says "bb." ends at 0.8 s, but the sound really runs to 1.0 s: the cut must not clip it
    words = [Word("Aa", 0.0, 0.5), Word("bb.", 0.5, 0.8), Word("Cc", 1.3, 1.8), Word("dd.", 1.8, 2.3)]
    ch = _Chunk(index=0, text="Aa bb. Cc dd.", style=get_style("conversational"), pace=1.0, seed=1, cuts=[(2, 400)])
    out, moved = s._apply_cuts(a, words, ch)
    gap = 0.4 - (0.3 - 0.03 - 0.02)                       # natural gap trimmed to 30 ms tail + 20 ms onset, then 400 ms added
    assert abs(len(out) / sr - (len(a) / sr + gap)) < 0.015
    assert abs(moved[2].start - (1.3 + gap)) < 0.015 and moved[1].end == 0.8
    assert np.abs(out[int(sr * 0.9): int(sr * 0.99)]).min() < 0.3 and np.abs(out[int(sr * 0.9): int(sr * 0.99)]).max() > 0.25   # tail kept
    assert np.abs(out[int(sr * 1.05): int(sr * 1.4)]).max() < 1e-4   # the pause is real silence
    assert np.abs(out[int(sr * (1.3 + gap)): int(sr * (1.3 + gap + 0.1))]).max() > 0.25          # next word intact


def test_acronyms_stay_written_for_engines_that_read_them():
    from firevoice.frontend.normalize import normalize
    t = "Your GPU runs the API. Send JSON, e.g. a PR."
    assert normalize(t) == "Your G P U runs the A P I. Send jason, for example a P R."
    assert normalize(t, spell_acronyms=False) == "Your GPU runs the API. Send jason, for example a PR."
