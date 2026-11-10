"""History: every output kept until the user deletes it."""
import numpy as np
import pytest


def _tone(sec=1.0, sr=16000):
    return (0.2 * np.sin(np.linspace(0, 2 * np.pi * 440 * sec, int(sr * sec)))).astype(np.float32)


def test_store_keeps_audio_and_text_and_survives_a_broken_record(svc):
    h = svc.history
    a = h.add("sound", "rain on a tin roof", audio={"audio": _tone()}, sr=16000, meta={"seed": 7})
    b = h.add("transcript", "call.m4a", audio={"audio": _tone(2)}, sr=16000, texts={"transcript.json": {"text": "hi"}, "transcript.txt": "hi"},
              compressed=("audio",))
    assert a["files"]["audio"]["file"] == "audio.flac" and b["files"]["audio"]["file"] == "audio.mp3"
    assert b["files"]["transcript.json"]["type"] == "json" and b["files"]["transcript.txt"]["type"] == "text" and abs(a["duration"] - 1.0) < 0.01
    (h.root / "20000101-000000-broken").mkdir()
    (h.root / "20000101-000000-broken" / "item.json").write_text("{not json", encoding="utf-8")
    ids = [x["id"] for x in h.list()]
    assert ids == [b["id"], a["id"]]                                   # newest first; the broken record is skipped
    assert [x["id"] for x in h.list(kind="sound")] == [a["id"]] and h.list(q="tin roof")[0]["id"] == a["id"]
    h.rename(a["id"], "Rain")
    assert h.get(a["id"])["title"] == "Rain"
    h.delete(a["id"])
    with pytest.raises(KeyError):
        h.get(a["id"])
    with pytest.raises(ValueError):
        h.add("nonsense", "x")
    with pytest.raises(KeyError):
        h.get("../voices")


def test_api_lists_serves_converts_and_deletes(svc):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    c = TestClient(create_app(svc))
    item = svc.history.add("changer", "me as Ember", audio={"audio": _tone()}, sr=16000)
    r = c.get("/api/v1/history").json()["items"]
    assert r[0]["id"] == item["id"] and r[0]["kind"] == "changer"
    mp3 = c.get(f"/api/v1/history/{item['id']}/files/audio?format=mp3")
    assert mp3.status_code == 200 and mp3.headers["content-type"] == "audio/mpeg" and len(mp3.content) > 1000
    flac = c.get(f"/api/v1/history/{item['id']}/files/audio?format=flac&download=true")
    assert flac.content[:4] == b"fLaC" and "attachment" in flac.headers["content-disposition"]
    assert c.patch(f"/api/v1/history/{item['id']}", json={"title": "Renamed"}).json()["title"] == "Renamed"
    assert c.get(f"/api/v1/history/{item['id']}/files/nope").status_code == 404
    assert c.delete(f"/api/v1/history/{item['id']}").json()["deleted"] is True
    assert c.get(f"/api/v1/history/{item['id']}").status_code == 404


def test_sound_and_separation_land_in_history(svc, monkeypatch):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    monkeypatch.setattr(svc, "sound", lambda prompt, kind, duration, seed=None, **kw: (_tone(duration), 16000,
                                                                                      {"seed": 5, "engine": "musicgen", "duration": duration, "license": "x"}))
    c = TestClient(create_app(svc))
    r = c.post("/api/v1/sound", json={"prompt": "calm piano", "kind": "music", "duration": 2})
    hid = r.headers["x-history-id"]
    item = c.get(f"/api/v1/history/{hid}").json()
    assert item["kind"] == "music" and item["title"] == "calm piano" and item["meta"]["seed"] == 5
    assert c.post("/api/v1/sound", json={"prompt": "door", "duration": 1, "save": False}).headers.get("x-history-id") is None

    import io

    import soundfile as sf
    monkeypatch.setattr(svc, "audio_separate", lambda path, mode: (_tone(), _tone() * 0.5, 16000))
    buf = io.BytesIO()
    sf.write(buf, _tone(), 16000, format="WAV")
    r = c.post("/api/v1/audio/separate", files={"file": ("song.wav", buf.getvalue(), "audio/wav")}, data={"mode": "vocals", "stem": "voice"})
    assert r.status_code == 200
    sep = c.get(f"/api/v1/history/{r.headers['x-history-id']}").json()
    assert sep["kind"] == "separate" and set(sep["files"]) == {"voice", "rest"}       # one run keeps both tracks
    assert c.get(f"/api/v1/history/{sep['id']}/files/rest").status_code == 200
    kinds = {x["kind"] for x in c.get("/api/v1/history").json()["items"]}
    assert {"music", "separate"} <= kinds and c.get("/api/v1/history?kind=music").json()["items"][0]["id"] == hid


def test_kept_renders_are_never_pruned(tmp_path):
    from firevoice.takestore import RenderStore
    s = RenderStore(tmp_path)
    assert s.keep is None
    for i in range(3):
        (tmp_path / f"r{i}").mkdir()
        (tmp_path / f"r{i}" / "render.json").write_text('{"chunks": []}', encoding="utf-8")
    s._prune()
    assert len(list(tmp_path.glob("*/render.json"))) == 3
