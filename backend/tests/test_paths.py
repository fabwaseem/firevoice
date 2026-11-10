"""Configurable paths: env var, then settings.json, then the source checkout, then the data folder."""
from pathlib import Path

from firevoice import paths


def test_resolution_order(tmp_path, monkeypatch):
    monkeypatch.setenv("FIREVOICE_HOME", str(tmp_path / "home"))
    for k in ("FIREVOICE_ENGINES_DIR", "FIREVOICE_WEIGHTS_DIR", "FIREVOICE_FFMPEG"):
        monkeypatch.delenv(k, raising=False)
    # running from this checkout, which has .envs: the checkout wins over the default
    monkeypatch.setattr(paths, "_CHECKOUT", tmp_path / "repo")
    assert paths.engines_dir() == tmp_path / "home" / "engines"           # no checkout -> data folder
    (tmp_path / "repo" / "src" / "firevoice").mkdir(parents=True)
    (tmp_path / "repo" / "pyproject.toml").write_text("")
    (tmp_path / "repo" / ".envs").mkdir()
    assert paths.engines_dir() == tmp_path / "repo" / ".envs"
    assert paths.weights("voxcpm2") == tmp_path / "repo" / ".envs" / "weights" / "voxcpm2"
    # settings.json beats the checkout
    paths.save_settings({"engines_dir": str(tmp_path / "eng"), "weights_dir": str(tmp_path / "w")})
    assert paths.engines_dir() == tmp_path / "eng" and paths.weights_dir() == tmp_path / "w"
    assert paths.engines_dir_info()[1] == "settings.json"
    # env beats settings
    monkeypatch.setenv("FIREVOICE_ENGINES_DIR", str(tmp_path / "envdir"))
    assert paths.engines_dir() == tmp_path / "envdir"
    assert paths.venv_python("voxcpm").parent.parent == tmp_path / "envdir" / "voxcpm"
    # removing a setting falls back
    paths.save_settings({"weights_dir": ""})
    assert paths.weights_dir() == tmp_path / "envdir" / "weights"


def test_ffmpeg_lookup(tmp_path, monkeypatch):
    monkeypatch.setenv("FIREVOICE_HOME", str(tmp_path))
    monkeypatch.delenv("FIREVOICE_FFMPEG", raising=False)
    fake = tmp_path / "bin" / f"ffmpeg{paths.EXE}"
    fake.parent.mkdir()
    fake.write_bytes(b"")
    assert paths.ffmpeg_info() == (str(fake), "data folder bin/")
    monkeypatch.setenv("FIREVOICE_FFMPEG", "X:/ff.exe")
    assert paths.ffmpeg() == "X:/ff.exe"


def test_unknown_setting_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("FIREVOICE_HOME", str(tmp_path))
    try:
        paths.save_settings({"nope": 1})
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


def test_settings_routes(svc, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    c = TestClient(create_app(svc))
    h = c.get("/health").json()
    assert h["api_version"] >= 3 and h["min_client_api"] >= 1
    rep = c.get("/api/v1/system/paths").json()
    assert {"home", "engines_dir", "weights_dir", "ffmpeg"} <= set(rep)
    assert c.put("/api/v1/system/settings", json={"engines_dir": str(tmp_path / "missing")}).status_code == 400
    (tmp_path / "eng").mkdir()
    r = c.put("/api/v1/system/settings", json={"engines_dir": str(tmp_path / "eng")}).json()
    assert r["restart_required"] and r["settings"]["engines_dir"] == str(tmp_path / "eng")
    r = c.put("/api/v1/system/settings", json={"engines_dir": ""}).json()
    assert "engines_dir" not in r["settings"] and r["restart_required"]


def test_worker_src_isolated_when_installed(tmp_path, monkeypatch):
    """An installed backend must not hand workers site-packages as PYTHONPATH (stray packages there shadow the
    engine venv's stdlib); it gets a folder holding only the firevoice package."""
    monkeypatch.setenv("FIREVOICE_HOME", str(tmp_path))
    if paths.checkout() is not None:                                  # running from this checkout
        assert paths.worker_src() == paths.checkout() / "src"
    monkeypatch.setattr(paths, "checkout", lambda: None)
    d = paths.worker_src()
    assert d.parent == tmp_path / "runtime" / "worker-src"
    assert [p.name for p in d.iterdir()] == ["firevoice"]
    # source in a checkout or a plain install, compiled modules in a release build
    assert any(f.suffix in (".py", ".pyd", ".so") for f in (d / "firevoice" / "core").glob("worker.*")) and (d / "firevoice" / ".complete").exists()
    assert paths.worker_src() == d                                    # reused, not copied again
