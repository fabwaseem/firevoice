"""Usage tracking and the numbers on the Stats screen."""
import time

import pytest

from firevoice import usage
from firevoice.service import TTSRequest


def _wait_seeded():
    for _ in range(50):                    # the seed thread runs once at start
        if usage._file().exists():
            return
        time.sleep(0.02)


def test_speech_is_counted_once_with_its_numbers(svc):
    _wait_seeded()
    svc.tts(TTSRequest(text="Hello there, this is one sentence of speech.", engine="null"))
    ev = [e for e in usage.events() if e["kind"] == "speech"]
    assert len(ev) == 1
    e = ev[0]
    assert e["status"] == "done" and e["engine"] == "null" and e["words"] == 8 and e["chars"] > 30 and e["audio_s"] > 0


def test_inner_calls_are_not_counted_twice(svc):
    _wait_seeded()
    inner = TTSRequest(text="Part of something bigger.", engine="null")
    setattr(inner, usage.INNER, True)
    svc.tts(inner)
    assert not [e for e in usage.events() if e["kind"] == "speech"]

    calls = []
    def outer():                               # a tracked operation calling another in the same thread
        calls.append(svc.tts(TTSRequest(text="Nested speech.", engine="null")))
        return {"text": "x", "language": "en", "duration": 1.0, "seconds": 0.1, "words": []}
    wrapped = usage._wrap(svc, outer, "transcript", usage._transcribe)
    wrapped()
    kinds = [e["kind"] for e in usage.events()]
    assert kinds.count("transcript") == 1 and kinds.count("speech") == 0


def test_failures_are_recorded_and_summary_adds_up(svc):
    _wait_seeded()
    for t in ("One sentence here.", "Another short sentence to speak."):
        svc.tts(TTSRequest(text=t, engine="null"))
    with pytest.raises(Exception):
        svc.tts(TTSRequest(text="This voice does not exist.", engine="null", voice="no-such-voice"))
    s = usage.summary(30)
    t = s["totals"]
    assert t["speech_renders"] == 2 and t["failed"] == 1 and 0 < t["success_rate"] < 1 and t["words_spoken"] == 8
    assert s["engines"][0]["key"] == "null" and len(s["daily"]) == 30 and len(s["heatmap"]) == 7 and len(s["heatmap"][0]) == 24
    assert s["records"]["active_days"] == 1 and s["records"]["streak"] == 1


def test_stats_route(svc):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    _wait_seeded()
    svc.tts(TTSRequest(text="Counting this one.", engine="null"))
    c = TestClient(create_app(svc))
    r = c.get("/api/v1/stats?days=7").json()
    assert r["totals"]["speech_renders"] == 1 and r["range"]["days"] == 7
    assert {"voices", "styles", "projects", "dictionary_rules"} <= set(r["library"]) and "folders" in r["storage"]
    assert c.get("/api/v1/stats?days=0").json()["range"]["days"] == 0


def test_seed_counts_past_work(tmp_path, monkeypatch):
    import json
    monkeypatch.setenv("FIREVOICE_HOME", str(tmp_path))
    (tmp_path / "history" / "a").mkdir(parents=True)
    (tmp_path / "history" / "a" / "item.json").write_text(json.dumps({"kind": "music", "created": time.time(), "duration": 30.0}), encoding="utf-8")
    usage.seed()
    ev = usage.events()
    assert len(ev) == 1 and ev[0]["kind"] == "music" and ev[0]["seeded"] is True
    usage.seed()                                # only once
    assert len(usage.events()) == 1
