"""Live dictation: words are released once two passes agree, never taken back, and cleaned on the way out."""
import numpy as np
import pytest

from firevoice.dictation import SR, LiveTranscriber, format_words


class Script:
    """A stand-in for the speech model: it "hears" a fixed script, one word every 0.4 s, and writes the newest word
    wrongly until more sound follows it (as a real model does with a word that is still being spoken)."""

    def __init__(self, text: str, gap: float = 0.4):
        self.words, self.gap, self.calls = text.split(), gap, []

    def __call__(self, audio, language=None, prompt=None, hotwords=None, beam=1):
        self.calls.append({"seconds": len(audio) / SR, "prompt": prompt, "hotwords": hotwords, "beam": beam})
        start = round(self.offset(audio), 3)
        out = []
        for i, w in enumerate(self.words):
            s, e = i * self.gap - start, (i + 1) * self.gap - start
            if e <= 0 or s >= len(audio) / SR:
                continue
            unfinished = e > len(audio) / SR + 1e-6
            out.append((w + "~" if unfinished and beam == 1 else w, max(0.0, s), min(e, len(audio) / SR)))
        return out, "en"

    def offset(self, audio) -> float:
        return float(audio[0]) if len(audio) else 0.0


def speech(seconds: float, at: float = 0.0) -> np.ndarray:
    """Loud enough to count as speech; the first sample carries the stream time, which Script reads back."""
    a = np.full(int(seconds * SR), 0.05, dtype=np.float32)
    if len(a):
        a[0] = at
    return a


def run(live: LiveTranscriber, total: float, step: float = 0.2):
    """Feed sound in small pieces as a microphone would; -> every event, in order."""
    events, t = [], 0.0
    while t < total - 1e-9:
        a = np.full(int(step * SR), 0.05, dtype=np.float32)
        live.feed(a)
        t += step
        # tell the stand-in where the window starts (it has no real sound to go by)
        live._audio[0] = live._start
        ev = live.step()
        if ev:
            events.append(ev)
    return events


def test_words_are_released_once_two_passes_agree_and_never_change():
    model = Script("the quick brown fox jumps over the lazy dog")
    live = LiveTranscriber(model)
    events = run(live, 3.6)
    committed = ""
    for ev in events:
        assert ev["text"].startswith(committed), "text that was given out changed"
        assert ev["text"] == committed + ev["commit"]
        assert "~" not in ev["text"], "an unfinished word was released"
        committed = ev["text"]
    assert committed.startswith("the quick brown fox") and events[0]["tentative"]
    live._audio[0] = live._start
    end = live.finish()
    assert end["text"] == "the quick brown fox jumps over the lazy dog" and end["text"] == committed + end["commit"]
    assert not end["replace"] and model.calls[-1]["beam"] == 3


def test_long_dictation_keeps_the_window_short():
    text = " ".join(f"word{i}" for i in range(150))             # a minute of speech
    model = Script(text)
    live = LiveTranscriber(model)
    run(live, 60.0)
    live._audio[0] = live._start
    assert live.finish()["text"] == text
    assert max(c["seconds"] for c in model.calls) < 12.0, "the window grew instead of being cut as words settled"
    assert any(c["prompt"] for c in model.calls), "what was said before is passed on as context"


def test_silence_is_not_transcribed():
    model = Script("hello")
    live = LiveTranscriber(model)
    for _ in range(20):
        live.feed(np.zeros(SR // 5, dtype=np.float32))
        assert live.step() is None
    assert not model.calls and live.finish()["text"] == ""
    assert len(live._audio) / SR <= 4.0, "a long silence was kept"


def test_refine_transcribes_a_short_dictation_again_as_a_whole():
    model = Script("send the report today")
    live = LiveTranscriber(model, refine=True, keyterms=["FireVoice", "Waseem"])
    run(live, 1.6)
    live._whole[0] = 0.0
    end = live.finish()
    assert end["replace"] and end["text"] == "send the report today"
    assert model.calls[-1]["beam"] == 5 and model.calls[-1]["hotwords"] == "FireVoice, Waseem"


@pytest.mark.parametrize("words, text", [
    ("Hello there new line how are you", "Hello there\nhow are you"),
    ("First point. New paragraph. Second point.", "First point.\n\nSecond point."),
    ("Um, we should uh go now", "We should go now"),
    ("So, um, yes", "So, yes"),
    ("a new car", "a new car"),
    ("newline done", "\ndone"),
])
def test_format(words, text):
    assert format_words(words.split()) == text


def test_format_options_and_holding_back_a_possible_command():
    w = "um add a new".split()
    assert format_words(w, fillers=False, commands=False) == "um add a new"
    assert format_words(w, final=False) == "add a"                 # "new" may be the start of "new line"
    assert format_words(w + ["line"], final=False) == "add a\n"
    assert format_words(w + ["idea"], final=False) == "add a new idea"


def test_route(svc):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    model = Script("please open the door new line thank you")
    svc._aligner.transcribe_window = model
    c = TestClient(create_app(svc))
    assert c.post("/api/v1/dictate/warm").status_code == 200
    with c.websocket_connect("/api/v1/dictate") as ws:
        ws.send_json({"type": "start", "language": "en", "sample_rate": 16000, "keyterms": ["door"]})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes((speech(3.2) * 32767).astype("<i2").tobytes())
        ws.send_json({"type": "stop"})
        got = []
        while True:
            m = ws.receive_json()
            got.append(m)
            if m["type"] in ("final", "error"):
                break
    assert got[-1]["type"] == "final" and got[-1]["text"] == "please open the door\nthank you"
    assert got[-1]["seconds"] == 3.2 and got[-1]["language"] == "en"
    assert "".join(m["commit"] for m in got) == got[-1]["text"], "the pieces add up to the whole"
    with c.websocket_connect("/api/v1/dictate") as ws:
        ws.send_json({"type": "hello"})
        assert ws.receive_json()["code"] == "bad_request"


# ------------------------------------------------------------------------------------------------ automatic language

class Langs:
    """A stand-in language detector: what it "hears" depends on how much sound there is."""

    def __init__(self, early, late, at=3.0):
        self.early, self.late, self.at, self.calls = early, late, at, 0

    def __call__(self, audio):
        self.calls += 1
        return self.late if len(audio) / SR >= self.at else self.early


def _languages_used(model):
    return [c["language"] for c in model.calls]


class ScriptLang(Script):
    def __call__(self, audio, language=None, prompt=None, hotwords=None, beam=1):
        out, _ = super().__call__(audio, language, prompt, hotwords, beam)
        self.calls[-1]["language"] = language
        return out, language or "en"


def test_auto_picks_only_among_the_speakers_languages_and_waits_until_sure():
    model = ScriptLang("hola que tal amigo mio como estas hoy")
    # the detector leans to Portuguese (not one of theirs), then is sure of Spanish
    det = Langs(early=[("pt", 0.5), ("es", 0.3), ("en", 0.2)], late=[("es", 0.9), ("en", 0.1)])
    live = LiveTranscriber(model, languages=["en", "es"], detect=det)
    run(live, 3.6)
    used = [l for l in _languages_used(model) if l]
    assert used and set(used) <= {"en", "es"}, used            # never a language they do not speak
    assert live.language == "es"


def test_a_wrong_early_guess_is_put_right_at_the_end():
    model = ScriptLang("bonjour tout le monde merci beaucoup")
    det = Langs(early=[("en", 0.9), ("fr", 0.1)], late=[("fr", 0.95), ("en", 0.05)], at=99)   # sure of English early
    live = LiveTranscriber(model, languages=["en", "fr"], detect=det, refine=True)
    run(live, 2.4)
    assert live.language == "en"                                  # settled early, and wrongly
    det.at = 0                                                    # the whole dictation says French
    live._audio[0] = live._start
    live.finish()
    assert live.language == "fr" and model.calls[-1]["language"] == "fr"


def test_a_chosen_language_is_never_changed_and_one_language_needs_no_detection():
    det = Langs(early=[("fr", 1.0)], late=[("fr", 1.0)])
    live = LiveTranscriber(ScriptLang("hello there my friend"), language="en", detect=det, refine=True)
    run(live, 1.6)
    live.finish()
    assert live.language == "en"
    one = LiveTranscriber(ScriptLang("hello there"), languages=["ur"], detect=det)
    assert one.language == "ur" and one.fixed
