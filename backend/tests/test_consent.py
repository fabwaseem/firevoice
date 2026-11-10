"""Consent records: kept with every cloned voice, carried through import, derived for library voices."""
import numpy as np
import soundfile as sf


def _clip(tmp_path, name="c.wav"):
    p = tmp_path / name
    sf.write(str(p), (0.2 * np.sin(np.linspace(0, 3000, 24000 * 6))).astype("float32"), 24000)
    return p


def test_record_kept_and_change_detected(svc, tmp_path):
    svc.voice_add("ana", _clip(tmp_path), consent=True, transcript="hi", consent_by="Ana Example", via="app")
    r = svc.voice_consent("ana")
    assert r["basis"] == "consent" and r["given"] and r["by"] == "Ana Example" and r["via"] == "app"
    assert len(r["upload_sha256"]) == 64 and r["clip_unchanged"] is True and r["time"].endswith("+00:00")
    # replacing the stored clip shows up
    ref = svc.voices.root / "ana" / "ref.wav"
    a, sr = sf.read(str(ref))
    sf.write(str(ref), a * 0.5, sr)
    r = svc.voice_consent("ana")
    assert r["clip_unchanged"] is False and "changed" in r["clip_note"]


def test_import_keeps_original_record(svc, tmp_path):
    svc.voice_add("ben", _clip(tmp_path), consent=True, transcript="hi", consent_by="Ben")
    pack = svc.voice_pack("ben")
    data = pack if isinstance(pack, (bytes, bytearray)) else pack[0]
    v = svc.voice_import(data, consent=True, voice_id="ben2")
    r = svc.voice_consent(v["voice_id"])
    assert r["via"] == "import" and r["original"]["by"] == "Ben"


def test_library_voice_basis(svc, tmp_path):
    svc.voices.add("lib", _clip(tmp_path), consent=True, transcript="hi", license="CC0-1.0", source="Some corpus")
    r = svc.voice_consent("lib")
    assert r["given"] is None and r["basis"].startswith("dataset licence CC0-1.0")


def test_consent_route(svc, tmp_path):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    c = TestClient(create_app(svc))
    with open(_clip(tmp_path), "rb") as f:
        r = c.post("/api/v1/voices", data={"name": "cara", "consent": "true", "transcript": "hi", "consent_by": "Cara"}, files={"file": ("c.wav", f, "audio/wav")})
    assert r.status_code == 201, r.text
    rec = c.get("/api/v1/voices/cara/consent").json()
    assert rec["by"] == "Cara" and rec["via"] == "api"
