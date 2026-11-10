"""CLI: the everyday commands end to end on the null engine, locally and through --remote."""
import json

import pytest

from firevoice.cli import main


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("FIREVOICE_HOME", str(tmp_path / "home"))
    # never load Whisper in tests: the service's validation aligner becomes the null aligner
    from firevoice import service
    from firevoice.asr import NullAligner
    monkeypatch.setattr(service.FireVoice, "aligner", lambda self: NullAligner())
    return tmp_path


def test_say_all_options(tmp_path, capsys):
    out = tmp_path / "hello.mp3"
    rc = main(["say", "Hello there. This is the command line.", "-o", str(out), "--engine", "null", "--design", "a calm test voice",
               "--style", "storyteller", "--pace", "1.1", "--set", "pause=1.2", "--lufs", "-18", "--seed", "7", "--json"])
    assert rc == 0 and out.exists() and out.with_suffix(".words.json").exists()
    info = json.loads(capsys.readouterr().out)
    assert info["engine"] == "null" and info["style"] == "storyteller" and info["duration"] > 0


def test_say_stdin_and_errors(tmp_path, monkeypatch, capsys):
    import io
    monkeypatch.setattr("sys.stdin", io.StringIO("Text from standard input."))
    assert main(["say", "-", "-o", str(tmp_path / "a.wav"), "--engine", "null", "--design", "x"]) == 0
    assert main(["say", "hi", "-o", str(tmp_path / "b.wav"), "--engine", "null", "--design", "x", "--style", "nope"]) == 2
    assert "unknown style" in capsys.readouterr().err
    assert main(["say", "hi", "-o", str(tmp_path / "c.wav"), "--engine", "voxcpm2", "--design", "x", "--param", "cfg_value=99"]) == 2


def test_batch(tmp_path):
    f = tmp_path / "lines.json"
    f.write_text(json.dumps([{"id": "a", "text": "First line here."}, {"id": "b", "text": "Second line.", "style": "calm"}]), encoding="utf-8")
    out = tmp_path / "out"
    assert main(["batch", str(f), "-o", str(out), "--engine", "null", "--design", "x", "--format", "mp3"]) == 0
    m = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert [x["id"] for x in m] == ["a", "b"] and (out / "a.mp3").exists() and (out / "b.words.json").exists()
    assert main(["batch", str(f), "-o", str(out), "--engine", "null", "--design", "x", "--format", "mp3"]) == 0   # skipped, still ok


def test_engines_styles_voices(tmp_path, capsys):
    assert main(["engines", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert any(r["name"] == "voxcpm2" for r in rows)
    assert main(["engines", "info", "voxcpm2"]) == 0
    assert "inference_timesteps" in capsys.readouterr().out
    assert main(["styles", "add", "mine", "--base", "calm", "--set", "pace=0.9", "--instruct", "softly"]) == 0
    assert json.loads(capsys.readouterr().out)["instruct"] == "softly"
    assert main(["styles", "remove", "mine"]) == 0
    capsys.readouterr()
    assert main(["voices", "add", "--name", "robo", "--description", "a flat robot", "--engine", "null"]) == 0
    capsys.readouterr()
    assert main(["voices", "list", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)[0]["voice_id"] == "robo"
    assert main(["voices", "update", "--name", "robo", "--accent", "synthetic"]) == 0
    assert main(["voices", "info", "--name", "nobody"]) == 2


def test_remote(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from firevoice import client as client_mod
    from firevoice.server import create_app
    from firevoice.service import FireVoice

    svc = FireVoice(default_engine="null")
    tc = TestClient(create_app(svc, token="t0k"))
    orig = client_mod.Client.__init__

    def init(self, url=client_mod.DEFAULT_URL, token=None, timeout=60.0):
        orig(self, url, token, timeout)
        tc.headers.update(self.http.headers)
        self.http = tc

    monkeypatch.setattr(client_mod.Client, "__init__", init)
    try:
        out = tmp_path / "remote.wav"
        assert main(["say", "Hello over the API.", "-o", str(out), "--design", "x", "--remote", "http://fv", "--token", "t0k", "--no-asr"]) == 0
        assert out.exists() and out.stat().st_size > 1000
        assert main(["say", "hi", "-o", str(out), "--design", "x", "--remote", "http://fv", "--token", "wrong"]) == 1
        assert main(["engines", "--remote", "http://fv", "--token", "t0k"]) == 0
    finally:
        svc.close()
