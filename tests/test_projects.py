"""Projects: chapters of paragraphs, statuses, background rendering, export (M4B chapters, subtitles, audiobook check),
bundles and voice packs."""
import io
import time
import zipfile

import numpy as np
import pytest
import soundfile as sf

from firevoice.projects import audiobook_check, master_audiobook, parse_text

SCRIPT = """# The Lighthouse
The keeper climbed the stairs every evening at dusk.

He counted each step out loud, a habit from his childhood.

Chapter 2: The Storm
That night the wind did not stop. Not once.
"""


def _client(svc):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    return TestClient(create_app(svc))


def test_parse_text_finds_chapters_and_paragraphs():
    chs = parse_text(SCRIPT)
    assert [c["title"] for c in chs] == ["The Lighthouse", "Chapter 2: The Storm"]
    assert [len(c["paragraphs"]) for c in chs] == [2, 1]
    assert parse_text("Just one paragraph.\n\nAnd another.")[0]["title"] == "Chapter 1"


def test_project_lifecycle(svc):
    c = _client(svc)
    defaults = {"engine": "null", "voice": "design:a calm narrator", "validate": False, "lufs": None}
    p = c.post("/api/v1/projects", json={"title": "Book", "text": SCRIPT, "defaults": defaults}).json()
    pid = p["id"]
    assert p["counts"]["draft"] == 3 and p["paragraphs"] == 3
    para = p["chapters"][0]["paragraphs"][0]
    # render one paragraph now; its takes live under /renders
    p = c.post(f"/api/v1/projects/{pid}/paragraphs/{para['id']}/render").json()
    first = p["chapters"][0]["paragraphs"][0]
    assert first["status"] == "rendered" and first["render"]["duration"] > 0
    assert c.get(f"/api/v1/renders/{first['render']['id']}").status_code == 200
    assert c.get(f"/api/v1/projects/{pid}/paragraphs/{para['id']}/audio", params={"format": "wav"}).status_code == 200
    # editing the text makes it stale; other paragraphs stay as they are
    chapters = p["chapters"]
    chapters[0]["paragraphs"][0]["text"] += " Always."
    p = c.patch(f"/api/v1/projects/{pid}", json={"chapters": chapters}).json()
    assert p["chapters"][0]["paragraphs"][0]["status"] == "stale" and p["counts"]["draft"] == 2
    # a different voice for one paragraph is a setting change too
    chapters = p["chapters"]
    chapters[1]["paragraphs"][0]["voice"] = "design:a stormy old sailor"
    p = c.patch(f"/api/v1/projects/{pid}", json={"chapters": chapters}).json()
    # render everything that changed, in the background
    job = c.post(f"/api/v1/projects/{pid}/render", json={"scope": "stale"}).json()
    for _ in range(200):
        st = c.get(f"/api/v1/jobs/{job['id']}").json()
        if st["status"] in ("done", "failed", "cancelled"):
            break
        time.sleep(0.1)
    assert st["status"] == "done" and st["result"]["rendered"] == 3, st
    p = c.get(f"/api/v1/projects/{pid}").json()
    assert p["counts"]["rendered"] == 3 and p["duration"] > 0
    assert c.post(f"/api/v1/projects/{pid}/render", json={}).status_code == 409    # nothing left to do
    # lock one, then "all" skips it
    lid = p["chapters"][0]["paragraphs"][1]["id"]
    p = c.post(f"/api/v1/projects/{pid}/paragraphs/{lid}/lock", json={"locked": True}).json()
    assert p["counts"]["locked"] == 1 and len(svc.project_todo(pid, "all")) == 2
    # exports
    r = c.get(f"/api/v1/projects/{pid}/export", params={"format": "wav"})
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    full, sr = sf.read(io.BytesIO(r.content))
    ch1 = c.get(f"/api/v1/projects/{pid}/export", params={"format": "wav", "chapter": p["chapters"][0]["id"]})
    assert len(sf.read(io.BytesIO(ch1.content))[0]) < len(full)
    m4b = c.get(f"/api/v1/projects/{pid}/export", params={"format": "m4b"})
    assert m4b.status_code == 200 and m4b.content[4:8] == b"ftyp" and b"chpl" in m4b.content or b"Chapter 2" in m4b.content
    srt = c.get(f"/api/v1/projects/{pid}/export", params={"format": "srt"}).text
    assert "-->" in srt
    chk = c.get(f"/api/v1/projects/{pid}/check", params={"master": "audiobook"}).json()
    assert len(chk["chapters"]) == 2 and all(any(x["name"] == "Peak" and x["ok"] for x in ch["checks"]) for ch in chk["chapters"])
    # bundle round trip: a new project with its own copies of every take
    b = c.get(f"/api/v1/projects/{pid}/bundle")
    assert b.status_code == 200 and zipfile.is_zipfile(io.BytesIO(b.content))
    imp = c.post("/api/v1/projects/import", files={"file": ("b.zip", b.content, "application/zip")}).json()
    assert imp["id"] != pid and imp["counts"]["rendered"] + imp["counts"]["locked"] == 3
    assert c.get(f"/api/v1/projects/{imp['id']}/export", params={"format": "wav"}).status_code == 200
    # deleting a paragraph removes its render; deleting the project removes the rest
    rid = p["chapters"][1]["paragraphs"][0]["render"]["id"]
    chapters = p["chapters"]
    chapters[1]["paragraphs"] = []
    c.patch(f"/api/v1/projects/{pid}", json={"chapters": chapters})
    assert c.get(f"/api/v1/renders/{rid}").status_code == 404
    assert c.delete(f"/api/v1/projects/{pid}").status_code == 200
    assert c.get(f"/api/v1/projects/{pid}").status_code == 404
    assert any(x["id"] == imp["id"] for x in c.get("/api/v1/projects").json()["projects"])


def test_project_validation(svc):
    c = _client(svc)
    assert c.post("/api/v1/projects", json={"title": "x", "defaults": {"style": "no-such-style"}}).status_code == 404
    assert c.post("/api/v1/projects", json={"title": "x", "defaults": {"paragraph_gap_ms": "long"}}).status_code == 400
    pid = c.post("/api/v1/projects", json={"title": "x", "text": "One. Two.", "defaults": {"engine": "null"}}).json()["id"]
    assert c.get(f"/api/v1/projects/{pid}/export").status_code == 409             # nothing rendered yet
    assert c.patch(f"/api/v1/projects/{pid}", json={"chapters": ["nope"]}).status_code == 400
    assert c.get("/api/v1/projects/..%5Cx").status_code == 404
    bad = io.BytesIO()
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr("project.json", "{}")
        z.writestr("../evil.txt", "x")
    assert c.post("/api/v1/projects/import", files={"file": ("b.zip", bad.getvalue())}).status_code == 400


def test_voice_pack_round_trip(svc, tmp_path):
    c = _client(svc)
    clip = tmp_path / "c.wav"
    sf.write(str(clip), (0.2 * np.sin(np.linspace(0, 3000, 24000 * 6))).astype("float32"), 24000)
    svc.voice_add("packme", clip, consent=True, gender="female", transcript="hello there")
    r = c.get("/api/v1/voices/packme/pack")
    assert r.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert "meta.json" in names and "ref.wav" in names
    assert c.post("/api/v1/voices/import", files={"file": ("v.zip", r.content)}, data={"consent": "false"}).status_code == 400
    v = c.post("/api/v1/voices/import", files={"file": ("v.zip", r.content)}, data={"consent": "true"}).json()
    assert v["voice_id"] == "packme-2" and svc.voices.ref_text("packme-2") == "hello there"


def test_audiobook_master_meets_the_limits():
    sr = 24000
    t = np.arange(sr * 8) / sr
    speech = (0.9 * np.sin(2 * np.pi * 180 * t) * (np.sin(2 * np.pi * 0.7 * t) > 0)).astype(np.float32)
    a = np.concatenate([np.zeros(int(sr * 0.7), np.float32), speech, np.zeros(int(sr * 2), np.float32)])
    before = audiobook_check(a, sr)
    after = audiobook_check(master_audiobook(a, sr), sr)
    peak = next(x for x in after["checks"] if x["name"] == "Peak")
    rms = next(x for x in after["checks"] if x["name"] == "Loudness (RMS)")
    assert peak["ok"] and rms["ok"], after
    assert not next(x for x in before["checks"] if x["name"] == "Peak")["ok"]
