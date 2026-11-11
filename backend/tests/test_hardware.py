"""Choosing the engine that suits a computer: fast enough, and the best quality that is."""
import pytest

from firevoice import hardware, installer


def _engine(name, title, quality, rtf, vram, clone=True):
    return {"name": name, "title": title, "task": "tts", "clone": clone, "vram_gb": vram,
            "tier": {"quality": quality, "rtf": rtf, "vram_gb": vram}}


ENGINES = [
    _engine("voxcpm2", "Inferno", "Studio", 0.41, 7.4),
    _engine("omnivoice", "Flare", "Pro", 0.18, 3.0),
    _engine("chatterbox-turbo", "Flash", "Standard", 0.2, 3.8),
    _engine("qwen3-tts", "Beacon", "Pro", 1.74, 5.0),
    _engine("f5", "Flicker", "Standard", 0.29, 3.0),
    _engine("kokoro", "Spark", "Standard", 0.04, 1.0, clone=False),
]


def hw(name, vram, disk=200.0):
    return {"gpu": name, "vram_gb": vram, "speed": hardware.gpu_speed(name, vram) if name else None, "disk_free_gb": disk}


@pytest.mark.parametrize("name,vram,expect", [
    ("NVIDIA GeForce RTX 5080", 15.9, "voxcpm2"),
    ("NVIDIA GeForce RTX 4090", 24.0, "voxcpm2"),
    ("NVIDIA GeForce RTX 4070", 12.0, "voxcpm2"),
    ("NVIDIA GeForce RTX 4060", 8.0, "omnivoice"),      # Inferno would not keep up, Flare is Pro quality and fast
    ("NVIDIA GeForce RTX 3060", 12.0, "omnivoice"),     # plenty of memory, but not fast enough for Inferno
    ("NVIDIA GeForce GTX 1650", 4.0, "kokoro"),
    ("NVIDIA GeForce RTX 3050 Laptop GPU", 4.0, "kokoro"),
    (None, None, "kokoro"),                              # no NVIDIA card
])
def test_the_pick_follows_the_computer(name, vram, expect):
    best, _ = hardware.choose(hw(name, vram), ENGINES)
    assert best["name"] == expect
    assert best["reason"]


def test_a_nearly_full_disk_steers_away_from_big_installs():
    best, _ = hardware.choose(hw("NVIDIA GeForce RTX 5080", 15.9, disk=4.0), ENGINES)
    assert best["name"] == "kokoro"


def test_the_room_the_runtime_still_needs_is_reserved():
    h = hw("NVIDIA GeForce RTX 4060", 8.0, disk=14.0)
    assert hardware.choose({**h, "torch": True}, ENGINES)[0]["name"] == "omnivoice"
    assert hardware.choose({**h, "torch": False}, ENGINES)[0]["name"] == "kokoro"    # 14 GB minus the runtime's 9.5 leaves too little


def test_engines_that_need_a_git_checkout_are_never_offered_first():
    names = {e["name"] for e in hardware.candidates([_engine("indextts2", "Firebrand", "Studio", 0.5, 8.0), *ENGINES])}
    assert "indextts2" not in names and "voxcpm2" in names


def test_the_alternatives_always_include_the_small_fallback():
    best, rest = hardware.choose(hw("NVIDIA GeForce RTX 5080", 15.9), ENGINES)
    assert best["name"] not in [r["name"] for r in rest] and "kokoro" in [r["name"] for r in rest]


def test_an_unknown_card_is_guessed_from_its_memory_and_laptops_are_slower():
    assert hardware.gpu_speed("NVIDIA Something New", 24) > hardware.gpu_speed("NVIDIA Something New", 6)
    assert hardware.gpu_speed("NVIDIA GeForce RTX 4060 Laptop GPU", 8) < hardware.gpu_speed("NVIDIA GeForce RTX 4060", 8)


def test_the_in_backend_engines_install_on_their_own():
    for name in ("chatterbox-turbo", "chatterbox", "chatterbox-vc"):
        m = installer.MANIFESTS[name]
        assert m.auto and m.venv is None and m.prefetch


@pytest.mark.parametrize("line,key", [
    ("failed to write to file `C:/u/uv/cache/x.dll`: There is not enough space on the disk. (os error 112)", "disk"),
    ("OSError: [Errno 28] No space left on device", "disk"),
    ("error sending request for url (https://download.pytorch.org/whl/cu128/)", "internet"),
    ("PermissionError: [WinError 5] Access is denied", "Windows would not let"),
])
def test_failures_are_told_in_plain_words(line, key):
    msg = installer.friendly([line])
    assert msg and key in msg.lower() or (msg and key in msg)


def test_an_unknown_failure_is_left_as_it_is():
    assert installer.friendly(["something nobody has seen"]) is None
