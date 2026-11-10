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
