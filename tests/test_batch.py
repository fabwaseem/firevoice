import json

import pytest

from firevoice.batch import run_batch

LINES = [{"id": "s01", "text": "Hey. Quick question for you today."}, {"id": "s02", "text": "The root does not know Wikipedia.", "style": "serious"}]


def test_run_batch_writes_files_and_manifest(make, tmp_path):
    s = make(cache=True)
    out = tmp_path / "out"
    entries = run_batch(s, LINES, out, lufs=None, log=None)
    assert [e["id"] for e in entries] == ["s01", "s02"]
    for sid in ("s01", "s02"):
        assert (out / f"{sid}.wav").exists() and (out / f"{sid}.words.json").exists()
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert {m["id"] for m in manifest} == {"s01", "s02"}
    assert all(k in manifest[0] for k in ("file", "duration", "warnings", "min_score", "takes", "attempts", "rtf"))
    again = run_batch(s, LINES, out, lufs=None, log=None)
    assert again == entries
    forced = run_batch(s, LINES[:1], out, lufs=None, force=True, log=None)
    assert forced[0]["cached_takes"] == forced[0]["takes"] > 0


def test_server_batch_route(svc, tmp_path):
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    from firevoice.server import create_app

    svc.cache_dir = str(tmp_path / "cache")
    c = TestClient(create_app(svc))
    assert c.get("/health").json()["ok"]
    out = tmp_path / "srv"
    lines = [{**l, "voice": "design:a test voice"} for l in LINES]
    r = c.post("/v1/batch", json={"lines": lines, "out_dir": str(out), "lufs": None})
    assert r.status_code == 200, r.text
    j = r.json()
    assert [e["id"] for e in j["entries"]] == ["s01", "s02"] and j["cache"]["misses"] > 0
    assert (out / "s01.wav").exists() and (out / "manifest.json").exists()
    r2 = c.post("/v1/batch", json={"lines": lines, "out_dir": str(out), "force": True, "lufs": None}).json()
    assert all(e["cached_takes"] == e["takes"] for e in r2["entries"])
