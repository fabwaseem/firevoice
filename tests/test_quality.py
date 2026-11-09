"""Quality reports: drift flags where the voice, pitch or level wanders; verdicts; routes (models stubbed)."""
import numpy as np
import soundfile as sf

from firevoice import quality

SR = 16000


def _tone(seconds, f0=150.0, amp=0.2):
    t = np.arange(int(SR * seconds)) / SR
    return (amp * (np.sin(2 * np.pi * f0 * t) + 0.4 * np.sin(2 * np.pi * 2 * f0 * t))).astype(np.float32)


def test_drift_flags_the_odd_window(monkeypatch):
    # windows 0-2 are "voice A", window 3 is "voice B" (the embedding is keyed on the tone's pitch)
    def fake_embed(a, sr, which=None):
        y = quality._to16(a, sr)
        spec = np.abs(np.fft.rfft(y[:SR]))
        e = np.zeros(8, np.float32)
        e[0 if np.argmax(spec) < 200 else 1] = 1.0
        e[2] = 0.3
        return e / np.linalg.norm(e)
    monkeypatch.setattr(quality, "embed", fake_embed)
    monkeypatch.setattr(quality, "backend", lambda: "wavlm")
    a = np.concatenate([_tone(8), _tone(8), _tone(8), _tone(8, f0=260.0)])
    d = quality.drift(a, SR)
    assert len(d["windows"]) == 4
    assert [f["start"] for f in d["flags"]] == [24.0]
    assert any("voice drifts" in w for w in d["flags"][0]["why"]) and any("pitch" in w for w in d["flags"][0]["why"])


def test_level_jump_flagged(monkeypatch):
    monkeypatch.setattr(quality, "embed", lambda a, sr, which=None: np.ones(4, np.float32) / 2)
    a = np.concatenate([_tone(8), _tone(8), _tone(8, amp=0.02)])
    d = quality.drift(a, SR)
    assert d["flags"] and "level" in d["flags"][0]["why"][0] and d["flags"][0]["start"] == 16.0


def test_report_verdict(monkeypatch):
    monkeypatch.setattr(quality, "embed", lambda a, sr, which=None: np.ones(4, np.float32) / 2)
    monkeypatch.setattr(quality, "mos", lambda a, sr: {"overall": 2.5, "signal": 3.0, "background": 4.0, "p808": 3.0})
    r = quality.report(_tone(5), SR, _tone(5), SR)
    assert r["verdict"] == "check" and r["similarity"]["same_speaker"] and any("rough" in n for n in r["notes"])


def test_routes(svc, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    from firevoice.service import TTSRequest
    monkeypatch.setattr(quality, "embed", lambda a, sr, which=None: np.ones(4, np.float32) / 2)
    monkeypatch.setattr(quality, "mos", lambda a, sr: {"overall": 4.0, "signal": 4.0, "background": 4.5, "p808": 4.0})
    c = TestClient(create_app(svc))
    p = tmp_path / "x.wav"
    sf.write(str(p), _tone(4), SR)
    with open(p, "rb") as f:
        r = c.post("/api/v1/audio/quality", files={"file": ("x.wav", f, "audio/wav")}).json()
    assert r["verdict"] == "good" and r["mos"]["overall"] == 4.0 and r["similarity"] is None
    rid = svc.tts(TTSRequest(text="Hello there, a kept render.", engine="null", keep_takes=True)).render_id
    q = c.get(f"/api/v1/renders/{rid}/quality").json()
    assert q["render_id"] == rid and "drift" in q
