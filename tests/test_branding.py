"""Voice branding: names, taglines, lookup by name, English previews, collections."""
import numpy as np
import soundfile as sf

from firevoice.branding import brand, collections, preview_text
from firevoice.voices import VoiceLibrary


def _lib(tmp_path):
    lib = VoiceLibrary(tmp_path)
    clip = tmp_path / "c.wav"
    t = np.linspace(0, 6, 24000 * 6, endpoint=False)
    sf.write(str(clip), (0.2 * np.sin(2 * np.pi * 160 * t)).astype("float32"), 24000)
    lib.add("glb-f-sco-s00001", clip, consent=True, gender="female", transcript="x", tags=["globe_v2"], extra={"language": "en", "accent_code": "sco"})
    lib.add("urd-m-cv01", clip, consent=True, gender="male", transcript="x", tags=["lang:ur"], extra={"language": "ur"})
    lib.add("lib-m-1188", clip, consent=True, gender="male", transcript="x")
    lib.add("dsg-robot", clip, consent=True, transcript="x", tags=["designed"], extra={"design_prompt": "a flat robotic AI assistant voice"})
    return lib


def test_brand_names_and_lookup(tmp_path):
    lib = _lib(tmp_path)
    rows = {r["voice_id"]: r for r in brand(lib, None, log=lambda *_: None)}
    assert rows["glb-f-sco-s00001"]["name"] == "Isla"
    assert rows["urd-m-cv01"]["name"] == "Bilal"
    assert rows["dsg-robot"]["name"] == "Axiom" and "Sci-fi" in rows["dsg-robot"]["use_cases"]
    assert "Scottish" in rows["glb-f-sco-s00001"]["tagline"]
    assert len({r["name"] for r in rows.values()}) == len(rows)
    assert lib.canonical("isla") == "glb-f-sco-s00001" and lib.exists("Bilal") and lib.get("Axiom")["voice_id"] == "dsg-robot"
    assert lib.resolve("Isla", needs_reference=True)["ref"]


def test_previews_are_english_and_user_names_survive(tmp_path):
    lib = _lib(tmp_path)
    brand(lib, None, log=lambda *_: None)
    for v in lib.list():
        text, lang = preview_text(v)
        assert text.isascii() and v["name"] in text   # English letters only, never Hindi or Urdu script
        assert lang == ("ur" if v.get("language") == "ur" else "en")
    lib.update("lib-m-1188", name="Captain", branded_by="user")
    brand(lib, None, log=lambda *_: None)
    assert lib.get("lib-m-1188")["name"] == "Captain"


def test_collections(tmp_path):
    lib = _lib(tmp_path)
    brand(lib, None, log=lambda *_: None)
    vs = [{**v, "kind": "designed" if "designed" in v.get("tags", []) else "cloned"} for v in lib.list()]
    shelves = {c["id"]: c for c in collections(vs)}
    assert shelves["urdu"]["voices"] == ["urd-m-cv01"] and "dsg-robot" in shelves["designed"]["voices"]


def test_api_brand_and_name_lookup(svc, tmp_path):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    clip = tmp_path / "c.wav"
    sf.write(str(clip), (0.2 * np.sin(np.linspace(0, 3000, 24000 * 6))).astype("float32"), 24000)
    svc.voice_add("glb-f-sco-s00002", clip, consent=True, gender="female", transcript="hello")
    svc.voices.update("glb-f-sco-s00002", accent_code="sco")
    c = TestClient(create_app(svc))
    assert c.post("/api/v1/voices/brand").status_code == 200
    v = c.get("/api/v1/voices/Isla").json()
    assert v["voice_id"] == "glb-f-sco-s00002" and v["tagline"]
    assert any(s["id"] == "accents" for s in c.get("/api/v1/voices/collections").json()["collections"])
    assert c.patch("/api/v1/voices/Isla", json={"name": "Fiona", "tagline": "my own tagline"}).json()["name"] == "Fiona"
    assert c.get("/api/v1/voices/glb-f-sco-s00002/preview").status_code == 200   # falls back to the original clip
    r = c.post("/api/v1/tts", json={"text": "Hello there.", "voice": "Fiona", "engine": "null", "format": "wav"})
    assert r.status_code == 200, r.text
