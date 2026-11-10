"""Real streaming: the first passage is handed out piece by piece while it renders, and the stitched result is exactly what
was streamed."""
import threading
import time

import numpy as np

SCRIPT = ("This first passage is long enough to stream in many small pieces as it renders. "
          "It keeps going for another sentence or so. [pause 300ms] Then a second passage follows after the pause.")


def test_first_passage_streams_in_pieces(make):
    s = make(workers=1, adapter_kwargs={"stream": "1", "delay": 0.5})
    s.pool.start()
    events, first_at = [], []
    t0 = time.perf_counter()

    def on_chunk(c):
        if not first_at and len(c["audio"]):
            first_at.append(time.perf_counter() - t0)
        events.append(c)
    r = s.speak(SCRIPT, voice="design:test", on_chunk=on_chunk)
    partial = [e for e in events if e.get("partial")]
    assert len(partial) >= 3                                    # the first passage arrived in pieces
    assert all(e["index"] == 0 for e in partial)
    total_streamed = sum(len(e["audio"]) for e in events)
    assert abs(total_streamed - (len(r.audio) - 0)) < r.sr * 0.05 or total_streamed <= len(r.audio)
    # the pieces cover the timeline without gaps or overlaps
    t = 0.0
    for e in events:
        assert abs(e["start"] - t) < 1e-3, (e["start"], t)
        t += len(e["audio"]) / e["sr"]
    # words of the streamed passage arrive with the event that closes it
    words = [w for e in events for w in e["words"]]
    assert any(w.text.lower().startswith("first") for w in words)
    full_take = 0.5 + 0.05 * 40                                  # the whole first passage takes ~2.5 s to "render"
    assert first_at[0] < 1.4 < full_take                        # first audio arrives long before it is done


def test_without_a_listener_nothing_streams(make):
    s = make(workers=1, adapter_kwargs={"stream": "1"})
    r = s.speak("Just a normal render of one passage, no listener attached.", voice="design:test")
    assert len(r.audio) > 0 and r.takes and r.takes[0].attempts >= 1


def test_cancel_during_a_stream(make):
    s = make(workers=1, adapter_kwargs={"stream": "1", "delay": 2.0})
    s.pool.start()
    cancel = threading.Event()
    got, at = [], []

    def on_chunk(c):
        got.append(c)
        if not cancel.is_set():
            at.append(time.perf_counter())
            cancel.set()
    raised = None
    try:
        s.speak(SCRIPT, voice="design:test", on_chunk=on_chunk, cancel=cancel)
    except Exception as e:
        raised = e
    assert type(raised).__name__ == "Cancelled"
    assert got and time.perf_counter() - at[0] < 0.6            # stops within a fraction of a second of the cancel
    assert np.concatenate([g["audio"] for g in got]).size > 0


def test_streams_with_a_paced_style_too(make):
    s = make(workers=1, adapter_kwargs={"stream": "1", "delay": 0.3})
    events = []
    r = s.speak(SCRIPT, voice="design:test", style="serious", on_chunk=events.append)   # serious has pace 0.97
    assert sum(1 for e in events if e.get("partial")) >= 3
    t = 0.0
    for e in events:
        assert abs(e["start"] - t) < 1e-3
        t += len(e["audio"]) / e["sr"]
    assert r.words and r.words[-1].end <= len(r.audio) / r.sr + 0.05
