"""Dubbing: line planning, fitting, placement, subtitles, and the job (speech to text and translation stubbed)."""
import time

import numpy as np
import soundfile as sf

from firevoice import dubbing

SR = 16000


def test_units_merge_short_bits():
    segs = [{"start": 0.0, "end": 2.0, "text": "Hello there."}, {"start": 2.1, "end": 2.6, "text": "Yes."},
            {"start": 3.0, "end": 6.0, "text": "Another line.", "speaker": None}, {"start": 7.0, "end": 9.0, "text": "  "}]
    u = dubbing.units(segs)
    assert [x["text"] for x in u] == ["Hello there. Yes.", "Another line."]
    assert u[0]["end"] == 2.6


def test_units_keep_speakers_apart():
    segs = [{"start": 0.0, "end": 0.8, "text": "Hi.", "speaker": "Speaker 1"}, {"start": 0.9, "end": 1.5, "text": "Hey.", "speaker": "Speaker 2"}]
    assert len(dubbing.units(segs)) == 2


def test_fit_caps_speed():
    a = np.ones(SR * 4, np.float32)
    out, speed = dubbing.fit(a, SR, 2.0, tempo=lambda x, sr, f: x[: int(len(x) / f)])
    assert speed == dubbing.MAX_SPEED and abs(len(out) / SR - 4 / 1.3) < 0.01
    same, s1 = dubbing.fit(a, SR, 5.0)
    assert s1 == 1.0 and same is a


def test_assemble_pushes_overlaps():
    a, b = np.ones(SR * 2, np.float32), np.ones(SR, np.float32)
    track, placed = dubbing.assemble([(0.0, a), (1.0, b), (5.0, b)], SR, 6.0)
    assert placed[0] == 0.0 and abs(placed[1] - (2.0 + dubbing.MIN_GAP_S)) < 1e-6 and placed[2] == 5.0
    assert len(track) >= 6 * SR


def test_subtitles_use_dubbed_times():
    lines = [{"at": 1.0, "duration": 2.0, "translation": "Hallo.", "speaker": None}]
    assert "00:00:01,000 --> 00:00:03,000\nHallo." in dubbing.subtitles(lines, "srt")
    assert dubbing.subtitles(lines, "vtt").startswith("WEBVTT")


def test_dub_job(svc, monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from firevoice import translate
    from firevoice.server import create_app
    monkeypatch.setattr(svc, "transcribe", lambda a, sr, **kw: {"language": "en", "segments": [
        {"start": 0.2, "end": 1.8, "text": "Good morning everyone."}, {"start": 2.4, "end": 4.0, "text": "Let us begin."}]})
    monkeypatch.setattr(translate, "translate", lambda texts, s, t, progress=None, model=None: [f"[{t}] {x}" for x in texts])
    p = tmp_path / "in.wav"
    sf.write(str(p), np.zeros(SR * 5, np.float32), SR)
    c = TestClient(create_app(svc))
    with open(p, "rb") as f:
        r = c.post("/api/v1/dub", data={"target_language": "de", "format": "wav"}, files={"file": ("in.wav", f, "audio/wav")})
    assert r.status_code == 202, r.text
    jid = r.json()["id"]
    for _ in range(200):
        j = c.get(f"/api/v1/jobs/{jid}").json()
        if j["status"] in ("done", "failed"):
            break
        time.sleep(0.05)
    assert j["status"] == "done", j
    assert j["result"]["lines"] == 2 and j["result"]["target_language"] == "de"
    srt = c.get(f"/api/v1/jobs/{jid}/files/dub.srt").text
    assert "[de] Good morning everyone." in srt
    # the upload is gone, and the jobs API cannot point a dub at any other file
    assert not any((svc.jobs.root.parent / "uploads").glob("*/source*")) if (svc.jobs.root.parent / "uploads").exists() else True
    bad = c.post("/api/v1/jobs", json={"kind": "dub", "payload": {"input": str(p), "target": "de"}})
    assert bad.status_code == 400
    assert c.post("/api/v1/dub", data={"target_language": "xx"}, files={"file": ("in.wav", open(p, "rb"), "audio/wav")}).status_code == 400
    keep = c.post("/api/v1/dub", data={"target_language": "de", "keep_voices": "true"}, files={"file": ("in.wav", open(p, "rb"), "audio/wav")})
    assert keep.status_code == 400 and "consent" in keep.text
