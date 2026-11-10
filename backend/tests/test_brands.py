"""FireVoice engine names: unique, accepted wherever an engine id is, with a measured tier."""
import pytest

from firevoice.core import brands, registry


def test_names_are_unique_and_never_an_engine_id():
    names = [b.name.lower() for b in brands.BRANDS.values()]
    assert len(names) == len(set(names))
    assert not set(names) & set(registry.all_engines())
    assert all(e in registry.all_engines() for e in brands.BRANDS)


@pytest.mark.parametrize("given,engine", [("Inferno", "voxcpm2"), ("spark", "kokoro"), ("FLASH", "chatterbox-turbo"), ("Bonfire", "musicgen")])
def test_names_resolve_like_ids(given, engine):
    assert registry.get_engine(given).name == engine


def test_every_speech_engine_has_a_measured_tier():
    for e, b in brands.BRANDS.items():
        d = brands.describe(e, registry.all_engines()[e].vram_gb)
        if b.quality == "-":
            continue
        assert b.rtf and d["tier"]["speed"] in ("Instant", "Fast", "Real-time", "Slow") and d["tier"]["size"] != "-"


def test_labels():
    assert [brands.speed_label(x) for x in (0.04, 0.2, 0.5, 2.0, None)] == ["Instant", "Fast", "Real-time", "Slow", "-"]
    assert [brands.size_label(x) for x in (1.0, 4.0, 6.0, 8.0, 14.0)] == ["XS", "S", "M", "L", "XL"]


def test_engine_description_carries_the_name(svc):
    e = svc.engine("Inferno")
    assert e["name"] == "voxcpm2" and e["title"] == "Inferno" and e["model"] == "VoxCPM2 2B"
    assert e["tier"]["quality"] == "Studio" and e["tier"]["size"] == "L" and e["speed_rtf"] == 0.41
