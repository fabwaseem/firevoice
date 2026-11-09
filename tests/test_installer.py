"""Engine installer: plans, the install marker, and install jobs (commands stubbed, nothing is downloaded)."""
import time
from pathlib import Path

import pytest

from firevoice import installer, paths


@pytest.fixture
def engines(tmp_path, monkeypatch):
    monkeypatch.setenv("FIREVOICE_ENGINES_DIR", str(tmp_path / "engines"))
    monkeypatch.setenv("FIREVOICE_WEIGHTS_DIR", str(tmp_path / "weights"))
    monkeypatch.setattr(installer, "uv", lambda: "uv")
    monkeypatch.setattr(installer, "_repo_size", lambda repo, rev=None: None)
    calls = []

    def fake_run(cmd, log, cancel, env=None, on_line=None):
        calls.append(cmd)
        if cmd[1:2] == ["venv"]:
            py = paths.venv_python(cmd[-1].replace("\\", "/").rsplit("/", 1)[-1])
            py.parent.mkdir(parents=True, exist_ok=True)
            py.write_text("")
        if "snapshot_download" in " ".join(cmd):
            d = Path(cmd[4])
            d.mkdir(parents=True, exist_ok=True)
            (d / "config.json").write_text("{}")
    monkeypatch.setattr(installer, "_run", fake_run)
    return calls


def test_plan_states(engines):
    p = installer.plan("kokoro")
    assert p["auto"] and not p["installed"] and p["venv_state"] == "missing"
    assert [s["step"] for s in p["steps"]] == ["venv", "torch", "packages", "check"]
    assert not installer.plan("breeze")["auto"] and installer.plan("ming")["repo_code"]
    assert installer.plan("chatterbox-turbo")["venv"] is None


def test_install_writes_marker_and_detects_changes(engines, monkeypatch):
    seen = []
    r = installer.install("voxcpm2", lambda k, n, m: seen.append((k, n, m)), __import__("threading").Event())
    assert r["built_venv"] and r["weights"] == ["voxcpm2"]
    steps = [c[1] if c[0] == "uv" else "py" for c in engines]
    assert steps[:3] == ["venv", "pip", "pip"]
    torch_cmd = engines[1]
    assert "torch==2.11.0" in torch_cmd and installer.TORCH_INDEX in torch_cmd
    assert seen[-1][2] == "installed" and seen[-1][0] == seen[-1][1]
    m = installer.MANIFESTS["voxcpm2"]
    assert installer.venv_state(m) == "ok" and installer.plan("voxcpm2")["installed"]
    # a second install with nothing to do only re-checks the import
    engines.clear()
    installer.install("voxcpm2", lambda *a: None, __import__("threading").Event())
    assert len(engines) == 1
    # a changed pin marks the venv outdated
    monkeypatch.setattr(m, "packages", m.packages + ["newthing==1.0"])
    assert installer.venv_state(m) == "outdated"


def test_interrupted_install_is_not_ok(engines, monkeypatch):
    def boom(cmd, *a, **k):
        if cmd[1:2] == ["venv"]:
            py = paths.venv_python("kokoro")
            py.parent.mkdir(parents=True, exist_ok=True)
            py.write_text("")
            return
        raise installer.InstallError("network down")
    monkeypatch.setattr(installer, "_run", boom)
    with pytest.raises(installer.InstallError):
        installer.install("kokoro", lambda *a: None, __import__("threading").Event())
    assert installer.venv_state(installer.MANIFESTS["kokoro"]) == "building"


def test_hand_built_venv_counts(engines):
    py = paths.venv_python("kokoro")
    py.parent.mkdir(parents=True)
    py.write_text("")
    assert installer.venv_state(installer.MANIFESTS["kokoro"]) == "ok"


def test_uninstall_shared_venv(engines):
    installer.install("qwen3-tts", lambda *a: None, __import__("threading").Event())
    r = installer.uninstall("qwen3-tts", weights=True)
    assert r["also_affects"] == ["qwen3-tts-design"]
    assert not paths.venv_python("qwen").exists() and not (paths.weights_dir() / "qwen3-tts-1.7b-base").exists()


def test_install_job(svc, engines, monkeypatch):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    c = TestClient(create_app(svc))
    assert c.post("/api/v1/engines/breeze/install").status_code == 400
    assert c.post("/api/v1/engines/nope/install").status_code == 404
    j = c.post("/api/v1/engines/kokoro/install").json()
    for _ in range(100):
        v = c.get(f"/api/v1/jobs/{j['id']}").json()
        if v["status"] in ("done", "failed"):
            break
        time.sleep(0.05)
    assert v["status"] == "done", v
    assert c.get(f"/api/v1/jobs/{j['id']}/files/install.log").status_code == 200
    assert c.get("/api/v1/engines/kokoro/install?sizes=false").json()["installed"]
    assert c.delete("/api/v1/engines/kokoro/install").json()["removed"]


def test_repo_engine_clones_pins_and_overrides(engines, monkeypatch):
    """A repo engine: checkout at the pinned commit, requirements with the torch override, pinned weights revision."""
    monkeypatch.setattr(installer.shutil, "which", lambda name: name)
    installer.install("ming", lambda *a: None, __import__("threading").Event())
    cmds = [" ".join(map(str, c)) for c in engines]
    m = installer.MANIFESTS["ming"]
    assert any("clone" in c and m.git[0] in c for c in cmds)
    assert any("checkout --force " + m.git[1] in c for c in cmds)
    pip = next(c for c in cmds if " -r " in c)
    assert "requirements.txt" in pip and "--override" in pip
    assert (paths.engines_dir() / ".ming-overrides.txt").read_text().split("\n") == m.overrides
    fetch = next(c for c in engines if "snapshot_download" in " ".join(map(str, c)))
    assert fetch[-1] == m.weights[0][2]
    p = installer.plan("ming", sizes=False)
    assert p["repo_code"] and any(s["step"] == "code" for s in p["steps"])


def test_editable_repo_install(engines, monkeypatch):
    monkeypatch.setattr(installer.shutil, "which", lambda name: name)
    installer.install("indextts25", lambda *a: None, __import__("threading").Event())
    pip = next(" ".join(map(str, c)) for c in engines if " -e " in " ".join(map(str, c)))
    assert "indextts-repo" in pip
