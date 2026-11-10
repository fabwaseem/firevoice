"""Dialogue: parsing, casting, the mix with stems, the dialogue job, and the tags catalog."""
import io
import time
import zipfile

import pytest

import numpy as np
import soundfile as sf

from firevoice.dialogue import auto_cast, parse

SCRIPT = """Ayesha: Assalam o Alaikum! Today we test the new dialogue feature.
Bilal: Bilkul. (laughs) It should keep each of us in our own voice.
Ayesha: And put a short gap between us.
This line continues Ayesha's turn.
[Narrator] They both nodded."""


def _client(svc):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    return TestClient(create_app(svc))


def test_parse_turns_and_stage_directions():
    turns = parse(SCRIPT)
    assert [t["speaker"] for t in turns] == ["Ayesha", "Bilal", "Ayesha", "Narrator"]
    assert "[laugh]" in turns[1]["text"] and "continues Ayesha" in turns[2]["text"]
    assert parse("Just narration with no speaker.")[0]["speaker"] == "Narrator"


def test_auto_cast_prefers_names_then_distinct_voices():
    voices = [{"voice_id": "v1", "name": "Ayesha", "gender": "female"}, {"voice_id": "v2", "name": "Grace", "gender": "female"},
              {"voice_id": "v3", "name": "Arthur", "gender": "male"}]
    cast = auto_cast(["Ayesha", "Bilal", "Narrator"], voices, {"Narrator": "v2"})
    assert cast["Ayesha"]["voice"] == "v1" and cast["Narrator"]["voice"] == "v2" and cast["Bilal"]["voice"] == "v3"


def _voices(svc, tmp_path):
    clip = tmp_path / "c.wav"
    sf.write(str(clip), (0.2 * np.sin(np.linspace(0, 3000, 24000 * 6))).astype("float32"), 24000)
    for n in ("ayesha-v", "bilal-v", "narr-v"):
        svc.voice_add(n, clip, consent=True, transcript="hello there")


def test_dialogue_route_mix_stems_zip(svc, tmp_path):
    _voices(svc, tmp_path)
    c = _client(svc)
    cast = {"Ayesha": "ayesha-v", "Bilal": "bilal-v", "Narrator": "narr-v"}
    info = c.post("/api/v1/dialogue/parse", json={"script": SCRIPT, "cast": cast}).json()
    assert info["speakers"] == ["Ayesha", "Bilal", "Narrator"]
    body = {"script": SCRIPT, "cast": cast, "defaults": {"engine": "null", "validate": False}, "lufs": None, "format": "wav"}
    j = c.post("/api/v1/dialogue", json={**body, "response": "json", "stems": True}).json()
    assert [t["speaker"] for t in j["turns"]] == ["Ayesha", "Bilal", "Ayesha", "Narrator"]
    assert all(a["end"] < b["start"] for a, b in zip(j["turns"], j["turns"][1:]))          # a gap between turns
    mix, sr = sf.read(io.BytesIO(__import__("base64").b64decode(j["audio_base64"])))
    stems = {k: sf.read(io.BytesIO(__import__("base64").b64decode(v)))[0] for k, v in j["stems"].items()}
    assert set(stems) == {"Ayesha", "Bilal", "Narrator"} and all(len(x) == len(mix) for x in stems.values())
    b0, b1 = j["turns"][1]["start"], j["turns"][1]["end"]
    assert np.abs(stems["Ayesha"][int(b0 * sr) + 100: int(b1 * sr) - 100]).max() == 0          # silent while Bilal speaks
    z = zipfile.ZipFile(io.BytesIO(c.post("/api/v1/dialogue", json={**body, "response": "zip"}).content))
    assert {"dialogue.wav", "dialogue.srt", "turns.json"} <= set(z.namelist()) and any(n.startswith("stems/") for n in z.namelist())
    assert "Bilal: " in z.read("dialogue.srt").decode()
    job = c.post("/api/v1/jobs", json={"kind": "dialogue", "payload": {**body}}).json()
    for _ in range(200):
        st = c.get(f"/api/v1/jobs/{job['id']}").json()
        if st["status"] in ("done", "failed"):
            break
        time.sleep(0.1)
    assert st["status"] == "done" and len(st["result"]["stems"]) == 3, st


def test_tags_catalog(svc):
    t = _client(svc).get("/api/v1/tags").json()
    assert any(x["tag"] == "[laugh]" for x in t["sound"]) and any(x["tag"] == "[whisper]" and x["style"] == "asmr" for x in t["delivery"])


def test_sound_cues_in_dialogue(svc, monkeypatch):
    import numpy as np

    from firevoice.core import catalog
    from firevoice.service import FireVoiceError
    script = "[music: calm piano]\nAna: Hello there, welcome.\n[sfx: a door creaks, 1.5s]\nBen: Sorry I am late."
    real = catalog.EngineInfo.status
    # sound engines not installed (whatever this machine has)
    monkeypatch.setattr(catalog.EngineInfo, "status", lambda self: {"ready": False} if self.task == "sfx" else real(self))
    with pytest.raises(FireVoiceError) as e:
        svc.dialogue(script)
    assert e.value.code == "unavailable"
    monkeypatch.setattr(catalog.EngineInfo, "status", lambda self: {"ready": True} if self.task == "sfx" else real(self))
    made = []

    def fake_sound(prompt, kind, duration, seed=None, **kw):
        made.append((kind, prompt, duration))
        return (0.3 * np.sin(np.linspace(0, 400, int(16000 * duration)))).astype(np.float32), 16000, {}
    monkeypatch.setattr(svc, "sound", fake_sound)
    d = svc.dialogue(script, lufs=None)
    assert ("sfx", "a door creaks", 1.5) in made and any(k == "music" for k, *_ in made)
    assert set(d["stems"]) == {"Ana", "Ben", "SFX", "Music"} and set(d["cast"]) == {"Ana", "Ben"}
    kinds = [t.get("kind") for t in d["turns"]]
    assert kinds[0] == "music" and "sfx" in kinds
    sfx = next(t for t in d["turns"] if t.get("kind") == "sfx")
    assert abs((sfx["end"] - sfx["start"]) - 1.5) < 0.05
    assert len(d["stems"]["Music"]) == len(d["audio"])
    assert "door" not in svc.dialogue_subtitles(d["turns"], "srt")
