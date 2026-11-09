"""The inaudible "made by FireVoice" mark: on by policy, off per request, found again by the detector."""
import io

import numpy as np
import pytest
import soundfile as sf

from firevoice import watermark as W

pytestmark = pytest.mark.skipif(not W.available(), reason="audioseal not installed")


def _speechlike(sr=24000, seconds=3.0):
    t = np.arange(int(sr * seconds)) / sr
    env = 0.5 + 0.5 * np.sin(2 * np.pi * 3 * t)
    return (0.2 * env * (np.sin(2 * np.pi * 180 * t) + 0.5 * np.sin(2 * np.pi * 360 * t) + 0.25 * np.sin(2 * np.pi * 720 * t))).astype(np.float32)


def test_embed_and_detect():
    a = _speechlike()
    y = W.embed(a, 24000)
    assert y.shape == a.shape
    r = W.detect(y, 24000)
    assert r["watermarked"] and r["firevoice"] and r["kind"] == "render"
    assert not W.detect(a, 24000)["watermarked"]
    assert W.detect(W.embed(a, 24000, "convert"), 24000)["kind"] == "convert"


def test_policy(monkeypatch):
    monkeypatch.setenv("FIREVOICE_WATERMARK", "all")
    assert W.wanted(None) and not W.wanted(False)
    monkeypatch.setenv("FIREVOICE_WATERMARK", "off")
    assert not W.wanted(None) and W.wanted(True)


def test_renders_marked_and_detect_route(svc, monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    monkeypatch.setenv("FIREVOICE_WATERMARK", "all")
    # the null engine renders silence; give it a voice so there is something to mark
    monkeypatch.setattr(svc, "_mark", lambda a, sr, kind="render": W.embed(a + _speechlike(sr, len(a) / sr)[: len(a)], sr, kind))
    c = TestClient(create_app(svc))
    r = c.post("/api/v1/tts", json={"text": "Hello there, this is a marked render.", "engine": "null", "format": "wav"})
    assert r.headers["x-watermarked"] == "1"
    det = c.post("/api/v1/audio/detect", files={"file": ("a.wav", r.content, "audio/wav")}).json()
    assert det["firevoice"], det
    off = c.post("/api/v1/tts", json={"text": "Hello there.", "engine": "null", "format": "wav", "watermark": False})
    assert off.headers["x-watermarked"] == "0"
    assert c.get("/api/v1/system/paths").json()["watermark"] == {"policy": "all", "available": True}
    assert c.put("/api/v1/system/settings", json={"watermark": "off"}).json()["settings"]["watermark"] == "off"
