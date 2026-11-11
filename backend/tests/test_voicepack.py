"""The voice library pack: adding voices safely, never undoing what a person did, and refusing a damaged download."""
import hashlib
import json
import threading
import zipfile

import pytest

from firevoice import voicepack


def _make_pack(path, ids, extra=None):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("pack.json", json.dumps({"version": 1, "ids": ids}))
        for i in ids:
            z.writestr(f"voices/{i}/meta.json", json.dumps({"voice_id": i, "name": i.upper()}))
            z.writestr(f"voices/{i}/ref.wav", b"RIFF" + bytes(64))
            z.writestr(f"voices/{i}/ref.txt", "hello there")
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    return path


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("FIREVOICE_HOME", str(tmp_path / "home"))
    ids = ["alpha", "beta", "gamma"]
    zp = _make_pack(tmp_path / "pack.zip", ids, {"voices/../evil/meta.json": "{}", "voices/x/../../escape.txt": "no", "other/readme.txt": "x"})
    data = zp.read_bytes()
    pack = {"version": 1, "url": zp.as_uri(), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "ids": ids, "default": "beta"}
    return tmp_path / "home" / "voices", pack, zp


def _run(root, pack):
    log = []
    r = voicepack.install(lambda d, t, m: log.append(m), threading.Event(), root=root, pack=pack)
    return r, log


def test_installs_every_voice_and_sets_the_default(env):
    root, pack, _ = env
    assert voicepack.status(root, pack)["installed"] is False
    r, log = _run(root, pack)
    assert r["added"] == 3 and r["skipped"] == 0
    for i in pack["ids"]:
        assert (root / i / "meta.json").exists() and (root / i / "ref.wav").exists() and (root / i / "ref.txt").exists()
    assert (root / "default.txt").read_text(encoding="utf-8") == "beta"
    st = voicepack.status(root, pack)
    assert st["installed"] and st["present"] == 3 and st["missing"] == 0
    assert any("Adding voices" in m for m in log)


def test_nothing_outside_the_voices_folder_is_written(env):
    root, pack, _ = env
    _run(root, pack)
    assert not (root.parent / "evil").exists() and not (root.parent / "escape.txt").exists() and not (root / "escape.txt").exists()
    assert sorted(p.name for p in root.iterdir() if p.is_dir()) == ["alpha", "beta", "gamma"]


def test_installing_again_changes_nothing_and_keeps_edits(env):
    root, pack, _ = env
    _run(root, pack)
    (root / "alpha" / "meta.json").write_text(json.dumps({"voice_id": "alpha", "name": "My own name"}), encoding="utf-8")
    r, _ = _run(root, pack)
    assert r["added"] == 0 and r["skipped"] == 3
    assert json.loads((root / "alpha" / "meta.json").read_text(encoding="utf-8"))["name"] == "My own name"


def test_a_deleted_voice_does_not_come_back(env):
    import shutil
    root, pack, _ = env
    _run(root, pack)
    shutil.rmtree(root / "gamma")
    assert voicepack.status(root, pack)["installed"] is True       # removed on purpose, not missing
    r, _ = _run(root, pack)
    assert r["added"] == 0 and not (root / "gamma").exists()


def test_an_existing_default_voice_is_kept(env):
    root, pack, _ = env
    root.mkdir(parents=True)
    (root / "default.txt").write_text("alpha", encoding="utf-8")
    _run(root, pack)
    assert (root / "default.txt").read_text(encoding="utf-8") == "alpha"


def test_a_download_that_does_not_match_its_checksum_is_refused(env):
    root, pack, _ = env
    with pytest.raises(voicepack.VoicePackError):
        _run(root, {**pack, "sha256": "0" * 64})
    assert not root.exists() or not any((root / i).exists() for i in pack["ids"])


def test_not_enough_room_is_said_in_plain_words(env, monkeypatch):
    root, pack, _ = env
    monkeypatch.setattr(voicepack, "_free", lambda p: 1000)
    with pytest.raises(voicepack.VoicePackError, match="Not enough free disk space"):
        _run(root, pack)


def test_no_pack_means_nothing_to_offer(tmp_path, monkeypatch):
    monkeypatch.setenv("FIREVOICE_HOME", str(tmp_path))
    assert voicepack.status(tmp_path / "voices", {"version": 0, "ids": []})["available"] is False
    with pytest.raises(voicepack.VoicePackError):
        _run(tmp_path / "voices", {"version": 0, "ids": []})
