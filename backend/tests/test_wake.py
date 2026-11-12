"""The wake phrase: "Hey FireVoice" opens a dictation; other speech does not."""
import numpy as np
import pytest

from firevoice import wake
from firevoice.wake import WakeSpotter, heard_name, match


def words(text: str, start: float = 0.0, each: float = 0.3):
    out = []
    for i, w in enumerate(text.split()):
        out.append((w, start + i * each, start + (i + 1) * each))
    return out


@pytest.mark.parametrize("said, ends", [
    ("Hey FireVoice", 0.6),
    ("Hey, FireVoice.", 0.6),
    ("hey fire voice", 0.9),
    ("Hey Fire-Voice tell John I'm late", 0.6),
    ("Hi FireVoice", 0.6),
    ("Okay, Fire Voice, new email", 0.9),
    ("hey five voice", 0.9),            # one sound off
    ("Hey Firevoice, write", 0.6),
    ("So hey FireVoice", 0.9),          # a short word before it
    ("Uh, hey Fire Voice", 1.2),
    ("high fire voice", 0.9),           # "Hi" as the speech model often writes it
    ("HeyFireVoice, open notes", 0.3),  # one word
    ("Hey fire vice", 0.9),
    # accents: the speech model hears the v as a b, or the i as "ai"
    ("Hey Fireboys", 0.6),
    ("Hey fire boys", 0.9),
    ("Hey, Fairboys!", 0.6),
    ("Hi Firevoix!", 0.6),
    ("Hey Fair Voice", 0.9),
])
def test_the_phrase_is_heard(said, ends):
    assert match(words(said)) == pytest.approx(ends)


@pytest.mark.parametrize("said", [
    "",
    "Hey",
    "Hey voice",
    "Hey Firefox",
    "Hey, Firebase is down",
    "Hey forever",
    "Hey fireworks tonight",
    "Hey Fairbanks",
    "Have your voice",
    "Voice.",
    "hey there how are you",
    "the fire was out of control",
    "Firefox is open",
    "voice notes are on",
    "I told my friend hey FireVoice works",   # in the middle of a sentence: not a call
    "Hello everyone",
    "Hey Siri",
    "Okay Google",
    "Me fire vice.",                    # heard in Urdu speech: no greeting, not a call
    "fire voice",                       # the name alone is not a call
    "They fire voice notes",
    "Hey fire",
])

def test_other_speech_is_not(said):
    assert match(words(said)) is None


@pytest.mark.parametrize("said, form", [
    ("Hey Fireboys!", "fireboys"),
    ("Hi, Fairboys.", "fairboys"),
    ("hey fire boys", "fireboys"),
    ("Hey FireVoice", "firevoice"),
    ("Voice.", None),
    ("Have your voice", None),
    ("Hey", None),
    ("Hey Firefox", None),
])
def test_teaching_takes_how_the_name_came_out(said, form):
    assert heard_name(said) == form


def test_a_taught_form_wakes_it():
    assert match(words("Hey Fireboy")) is None
    assert match(words("Hey Fireboy"), learned=["fireboy"]) == pytest.approx(0.6)
    assert match(words("Hey Firefox"), learned=["fireboy"]) is None


class FakeVad:
    """Speech wherever the audio is not zero (in 10 ms steps), like the real detector."""

    def __call__(self, audio):
        on = np.abs(audio).reshape(-1, 160).max(axis=1) > 0 if len(audio) % 160 == 0 else np.abs(audio[: len(audio) // 160 * 160]).reshape(-1, 160).max(axis=1) > 0
        segs, start = [], None
        for i, v in enumerate(on):
            if v and start is None:
                start = i
            if not v and start is not None:
                segs.append({"start": start * 160, "end": i * 160})
                start = None
        if start is not None:
            segs.append({"start": start * 160, "end": len(on) * 160})
        return segs


def tone(seconds):
    return np.full(int(seconds * wake.SR), 0.1, dtype=np.float32)


def quiet(seconds):
    return np.zeros(int(seconds * wake.SR), dtype=np.float32)


def run(spotter, chunks):
    for c in chunks:
        for i in range(0, len(c), 1600):
            spotter.feed(c[i:i + 1600])
            hit = spotter.step()
            if hit:
                return hit
    return None


def test_the_phrase_alone_then_a_pause_wakes_it():
    heard = []

    def transcribe(a):
        heard.append(len(a) / wake.SR)
        return words("Hey FireVoice")

    hit = run(WakeSpotter(transcribe, FakeVad()), [quiet(1.0), tone(0.8), quiet(1.0)])
    assert hit and hit["heard"] == "Hey FireVoice"
    # the phrase ended 0.6 s into the stretch, which began 0.15 s before the speech (at 1.0 s)
    assert hit["at"] == pytest.approx(0.85 + 0.6, abs=0.02)
    assert 1 <= len(heard) <= 2


def test_the_phrase_followed_by_dictation_wakes_it_while_still_speaking():
    hit = run(WakeSpotter(lambda a: words("Hey FireVoice tell John I am late"), FakeVad()), [quiet(0.5), tone(6.0)])
    assert hit is not None
    assert hit["at"] < 2.5                     # found while the speech was still going on, not at its end


def test_other_speech_is_looked_at_once_and_never_wakes_it():
    calls = []

    def transcribe(a):
        calls.append(1)
        return words("so what do you think about the numbers for this quarter")

    hit = run(WakeSpotter(transcribe, FakeVad()), [quiet(0.5), tone(7.0), quiet(1.0), tone(0.2), quiet(1.0)])
    assert hit is None
    # the long stretch a few times while its opening comes in (never after LOOK_S of it); the short sound not at all
    assert 1 <= len(calls) <= 5


def test_speech_already_going_on_when_listening_starts_is_not_an_opening():
    # a long sentence whose start was not heard: its first words are not the start of anything said to FireVoice
    calls = []
    sp = WakeSpotter(lambda a: calls.append(1) or words("Hey FireVoice"), FakeVad())
    sp.feed(tone(9.0))                          # more than is kept: speech runs to the window's edge
    sp._last_step = 0
    assert sp.step() is None
    assert calls == []


def test_teaching_keeps_the_forms_that_did_not_wake_it_and_the_listener_uses_them(svc):
    sp = svc.wake_spotter()
    state = svc.wake_teach("start")
    assert state["active"] and state["attempts"] == []
    assert svc.wake_teaching()
    # what the listener heard on three attempts: two came out in the user's own way, one already woke it
    sp._debug(np.zeros(1600, np.float32), "Hey Fireboy!", False, 16000)
    sp._debug(np.zeros(1600, np.float32), "Hey FireVoice", True, 48000)
    sp._debug(np.zeros(1600, np.float32), "Hey Fireboy", False, 96000)
    state = svc.wake_teach("state")
    assert [a["form"] for a in state["attempts"]] == ["fireboy", "firevoice", "fireboy"]
    state = svc.wake_teach("save")
    assert not state["active"] and state["forms"] == ["fireboy"]
    assert sp.learned == ["fireboy"]                       # the running listener takes it at once
    assert svc.wake_spotter().learned == ["fireboy"]       # and so does the next one
    assert svc.dictation_store.load()["words"] == []       # the word list is not touched
    svc.wake_forget()
    assert sp.learned == [] and svc.wake_teach("state")["forms"] == []


def test_cancelled_teaching_keeps_nothing(svc):
    sp = svc.wake_spotter()
    svc.wake_teach("start")
    sp._debug(np.zeros(1600, np.float32), "Hey Fireboy", False, 16000)
    assert svc.wake_teach("cancel")["forms"] == []
    assert not svc.wake_teaching()
