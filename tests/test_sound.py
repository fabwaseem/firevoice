"""Sound effects and music: listed apart from speech engines, installable, validated (models not run here)."""
import pytest

from firevoice import installer


def test_sfx_engines_listed_apart(svc):
    names = {e["name"] for e in svc.engines()}
    sfx = {e["name"]: e for e in svc.engines("sfx")}
    assert "audioldm2" not in names and "musicgen" not in names
    assert set(sfx) == {"audioldm2", "musicgen"} and all(e["task"] == "sfx" and e["installable"] for e in sfx.values())
    assert {e["name"] for e in svc.engines("all")} >= names | set(sfx)
    assert installer.MANIFESTS["audioldm2"].venv == installer.MANIFESTS["musicgen"].venv == "sfx"


def test_sound_validation(svc, monkeypatch):
    from firevoice.service import FireVoiceError
    with pytest.raises(FireVoiceError) as e:
        svc.sound("", "sfx")
    assert e.value.code == "bad_request"
    with pytest.raises(FireVoiceError) as e:
        svc.sound("rain", "noise")
    assert e.value.code == "bad_request"
    with pytest.raises(FireVoiceError) as e:
        svc.sound("rain", "sfx", engine="null")
    assert e.value.code == "bad_request"


def test_sound_route_not_installed(svc, monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from firevoice.core import catalog
    from firevoice.server import create_app
    monkeypatch.setattr(catalog.EngineInfo, "status", lambda self: {"ready": False, "venv_ok": False, "weights_ok": False, "problems": ["missing"]})
    c = TestClient(create_app(svc))
    r = c.post("/api/v1/sound", json={"prompt": "rain on a tin roof", "kind": "sfx", "duration": 3})
    assert r.status_code == 503 and "install" in r.json()["error"]["message"]
    assert c.get("/api/v1/engines?task=sfx").status_code == 200
    assert c.post("/api/v1/sound", json={"prompt": "x", "duration": 99}).status_code == 400
