import json

import pytest

from firevoice.frontend import make_chunks, normalize, split_sentences
from firevoice.frontend.normalize import is_english_text
from firevoice.voices import VoiceLibrary


def test_urdu_and_devanagari_sentence_marks_split():
    assert split_sentences("آج موسم اچھا ہے۔ کیا آپ چائے پئیں گے؟ ٹھیک ہے۔") == ["آج موسم اچھا ہے۔", "کیا آپ چائے پئیں گے؟", "ٹھیک ہے۔"]
    assert split_sentences("आज मौसम अच्छा है। क्या आप चाय पिएंगे? ठीक है।") == ["आज मौसम अच्छा है।", "क्या आप चाय पिएंगे?", "ठीक है।"]
    assert len(split_sentences("今日は良い天気です。一緒にお茶を飲みませんか？")) == 2


def test_english_splitting_unchanged():
    assert split_sentences("Dr. Smith went home. It was 5 p.m. Okay!") == ["Dr. Smith went home.", "It was 5 p.m. Okay!"]


def test_non_english_text_keeps_digits():
    assert "2023" in normalize("میں نے 2023 میں شروع کیا۔")
    assert "2023" in normalize("Maine 2023 mein shuru kiya.", lang="ur")
    assert "twenty twenty-three" in normalize("It started in 2023.")
    assert not is_english_text("आज मौसम अच्छा है")
    assert is_english_text("Hello there")


def test_long_urdu_text_is_chunked():
    s = "یہ ایک لمبا جملہ ہے جس میں بہت سارے الفاظ ہیں اور یہ چلتا رہتا ہے۔ "
    assert len(make_chunks(s * 8)) > 1


def test_design_voice_resolves_without_library_entry(tmp_path):
    lib = VoiceLibrary(tmp_path)
    v = lib.resolve("design:A calm old man", needs_reference=False)
    assert v["ref"] is None and v["desc"] == "A calm old man" and v["voice_id"].startswith("design-")
    with pytest.raises(ValueError):
        lib.resolve("design:A calm old man", needs_reference=True)


def test_showcase_expansion(tmp_path):
    import numpy as np
    import soundfile as sf
    from firevoice.showcase import _custom_style, expand_section

    lib = VoiceLibrary(tmp_path)
    clip = tmp_path / "c.wav"
    sf.write(str(clip), (0.1 * np.sin(np.linspace(0, 3000, 24000 * 5))).astype("float32"), 24000)
    lib.add("a-en", clip, consent=True, gender="male", transcript="x")
    lib.add("b-ur", clip, consent=True, gender="female", transcript="x", tags=["lang:ur"], extra={"language": "ur"})
    plan = {"texts": {"t1": {"text": "Hello.", "lang": "en"}, "t2": "Bye."}, "sections": []}
    sec = {"id": "s", "voices": ["@lang:ur", "design:A robot"], "texts": ["t1", "t2"],
           "variants": [{"label": "plain"}, {"label": "ult", "set": {"ultimate": True, "cfg": 3.0}}]}
    items = expand_section(sec, plan, lib)
    assert len(items) == 2 * 2 * 2
    assert {i.voice for i in items} == {"b-ur", "design:A robot"}
    ult = next(i for i in items if i.variant == "ult")
    p = _custom_style(ult).params()
    assert p["ultimate"] is True and p["cfg_value"] == 3.0
    assert len({i.id for i in items}) == len(items)
    json.dumps([i.__dict__ for i in items])


def test_bradley_terry_orders_players():
    from firevoice.judge.grm import bt_fit, rounds_for
    res = [("a", "b", 1.0), ("a", "c", 1.0), ("b", "c", 1.0), ("a", "b", 1.0), ("c", "b", 0.5)]
    r = bt_fit(["a", "b", "c"], res)
    assert r["a"] > r["b"] > r["c"]
    assert rounds_for(2) == 1 and rounds_for(4) == 3 and rounds_for(101) == 8


def test_style_fit_direction():
    from firevoice.judge.report import fit, pct
    base = {"arousal": 0.5, "valence": 0.5, "emotion": {"happy": 0.1}, "rate_wps": 2.5}
    excited = {"arousal": 0.65, "valence": 0.6, "emotion": {"happy": 0.6}, "rate_wps": 3.2}
    flat = dict(base)
    t = {"arousal": 1, "valence": 1, "happy": 1, "rate": 1}
    assert fit(excited, base, t) > 0.85 and abs(fit(flat, base, t) - 0.5) < 1e-6
    assert pct({"x": 1.0, "y": 3.0, "z": 2.0}) == {"x": 0.0, "z": 50.0, "y": 100.0}
