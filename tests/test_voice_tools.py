"""Voice tools: clip check and cleanup, design candidates, per-style clips, voice changer validation."""
import io

import numpy as np
import soundfile as sf

from firevoice.cleanup import analyze, clean


def _client(svc):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    return TestClient(create_app(svc))


def _noisy(sr=24000, seconds=8, noise=0.03, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(sr * seconds) / sr
    speech = 0.3 * np.sin(2 * np.pi * 180 * t) * (np.sin(2 * np.pi * 0.8 * t) > 0)
    return (speech + noise * rng.standard_normal(len(t))).astype(np.float32), sr


def test_analyze_and_clean_improve_a_noisy_clip():
    a, sr = _noisy()
    before = analyze(a, sr)
    out = clean(a, sr, "strong")
    after = analyze(out, sr)
    assert before["verdict"] in ("poor", "fair") and any("nois" in n for n in before["notes"])
    assert after["snr_db"] > before["snr_db"] + 6, (before, after)
    quiet = analyze(np.zeros(12000, np.float32), 24000)
    assert quiet["verdict"] == "poor"


def test_audio_routes_and_clean_voice(svc, tmp_path):
    c = _client(svc)
    a, sr = _noisy()
    buf = io.BytesIO()
    sf.write(buf, a, sr, format="WAV")
    rep = c.post("/api/v1/audio/analyze", files={"file": ("n.wav", buf.getvalue())}).json()
    assert "snr_db" in rep and rep["notes"]
    r = c.post("/api/v1/audio/clean", files={"file": ("n.wav", buf.getvalue())}, data={"strength": "medium"})
    assert r.status_code == 200 and "snr_db" in r.headers["x-quality-after"]
    assert c.post("/api/v1/audio/clean", files={"file": ("n.wav", buf.getvalue())}, data={"strength": "max"}).status_code == 400
    clip = tmp_path / "n.wav"
    sf.write(str(clip), a, sr)
    v = c.post("/api/v1/voices", files={"file": ("n.wav", clip.read_bytes())},
               data={"name": "noisy", "consent": "true", "transcript": "hello", "clean": "medium"}).json()
    assert v["quality_check"]["cleaned"] == "medium" and v["quality_check"]["after"]["snr_db"] > v["quality_check"]["before"]["snr_db"]
    v = c.post("/api/v1/voices/noisy/clean", json={"strength": "light"}).json()
    assert v["quality_check"]["cleaned"] == "light"
    assert c.post("/api/v1/voices/noisy/restore-original").status_code == 200


def test_design_candidates_and_keep(svc):
    c = _client(svc)
    b = c.post("/api/v1/voices/design/candidates", json={"description": "a warm old storyteller", "n": 3, "engine": "null", "seed": 5}).json()
    assert len(b["candidates"]) == 3 and len({x["seed"] for x in b["candidates"]}) == 3
    assert c.get(f"/api/v1/voices/design/candidates/{b['batch']}/2/audio").status_code == 200
    assert c.get(f"/api/v1/voices/design/candidates/{b['batch']}/9/audio").status_code == 404
    v = c.post(f"/api/v1/voices/design/candidates/{b['batch']}/2/keep", json={"name": "teller", "gender": "male"}).json()
    assert v["voice_id"] == "teller" and v["kind"] == "designed" and v["design_prompt"] == "a warm old storyteller"
    assert c.post(f"/api/v1/voices/design/candidates/{b['batch']}/2/keep", json={"name": "teller"}).status_code == 409


def test_style_clip_build_and_remove(svc, tmp_path):
    c = _client(svc)
    clip = tmp_path / "c.wav"
    sf.write(str(clip), (0.2 * np.sin(np.linspace(0, 3000, 24000 * 6))).astype("float32"), 24000)
    svc.voice_add("styled", clip, consent=True, transcript="hello there")
    v = c.post("/api/v1/voices/styled/styles/calm/build", json={"engine": "null", "text": "A calm, slow sentence."}).json()
    assert "calm" in v["styles"] and svc.voices.ref_text("styled", "calm") == "A calm, slow sentence."
    assert svc.voices.ref_path("styled", "calm").endswith("calm.wav")
    assert c.delete("/api/v1/voices/styled/styles/calm").json()["styles"] == []
    assert c.post("/api/v1/voices/styled/styles/no-such-style/build", json={"engine": "null"}).status_code == 404


def test_voice_changer_validates_input(svc, tmp_path):
    c = _client(svc)
    buf = io.BytesIO()
    sf.write(buf, np.zeros(2400, np.float32), 24000, format="WAV")
    assert c.post("/api/v1/voice-changer", files={"file": ("s.wav", buf.getvalue())}, data={"voice": "default"}).status_code == 400
    assert "chatterbox-vc" not in [e["name"] for e in c.get("/api/v1/engines").json()["engines"]]
