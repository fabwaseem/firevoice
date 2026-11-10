"""Word edits inside a take: the splice keeps the audio around the change and moves word times correctly."""
import numpy as np

from firevoice import wordedit

SR = 16000


def _take(words, sr=SR, tone=220.0):
    """A synthetic take: each word a 0.3 s tone burst, 0.1 s of silence between words."""
    parts, out, t = [], [], 0.05
    parts.append(np.zeros(int(0.05 * sr), np.float32))
    for i, w in enumerate(words):
        n = int(0.3 * sr)
        parts.append((0.3 * np.sin(2 * np.pi * (tone + 40 * i) * np.arange(n) / sr)).astype(np.float32))
        out.append({"text": w, "start": round(t, 3), "end": round(t + 0.3, 3)})
        t += 0.3
        parts.append(np.zeros(int(0.1 * sr), np.float32))
        t += 0.1
    return np.concatenate(parts), out


def test_common_edges():
    a = [{"text": w} for w in "the quick brown fox jumps".split()]
    b = [{"text": w} for w in "the quick red fox jumps".split()]
    assert wordedit.common_edges(a, b) == (2, 2)
    assert wordedit.common_edges(a, a) == (5, 0)


def test_splice_replaces_only_the_changed_word():
    old_a, old_w = _take("the quick brown fox jumps over".split())
    new_a, new_w = _take("the quick red fox jumps over".split(), tone=500.0)
    r = wordedit.splice(old_a, old_w, new_a, new_w, SR)
    assert r is not None and r["changed"] == [2, 3, 2, 3]
    assert [w["text"] for w in r["words"]] == "the quick red fox jumps over".split()
    # the audio before the edit is the old take, sample for sample (up to the crossfade)
    cut = int(r["cuts_s"][0] * SR) - int(wordedit.XFADE_S * SR)
    assert np.allclose(r["audio"][:cut], old_a[:cut])
    # every cut sits in silence, never inside a word
    for c in r["cuts_s"]:
        assert all(not (w["start"] < c < w["end"]) for w in old_w)
    # words after the edit keep their spacing
    assert abs((r["words"][4]["start"] - r["words"][3]["start"]) - 0.4) < 0.02
    assert abs(len(r["audio"]) - len(old_a)) < int(0.05 * SR)


def test_longer_edit_shifts_the_tail():
    old_a, old_w = _take("we meet at noon today friends".split())
    new_a, new_w = _take("we meet at half past noon today friends".split(), tone=400.0)
    r = wordedit.splice(old_a, old_w, new_a, new_w, SR)
    assert r is not None
    assert [w["text"] for w in r["words"]] == "we meet at half past noon today friends".split()
    assert len(r["audio"]) > len(old_a) + int(0.6 * SR)
    assert r["words"][-1]["end"] <= len(r["audio"]) / SR + 0.01


def test_big_change_uses_the_whole_take():
    old_a, old_w = _take("one two three four five".split())
    new_a, new_w = _take("six seven eight nine five".split())
    assert wordedit.splice(old_a, old_w, new_a, new_w, SR) is None


def test_render_edit_end_to_end(svc):
    from firevoice.service import TTSRequest
    out = svc.tts(TTSRequest(text="The first sentence stays. The second one will change soon.", engine="null", keep_takes=True))
    rid = out.render_id
    m = svc.render_get(rid)
    ch = m["chunks"][-1]
    new = ch["text"].replace("change", "move")
    m2 = svc.render_edit(rid, ch["index"], new)
    ch2 = next(c for c in m2["chunks"] if c["index"] == ch["index"])
    assert ch2["text"] == new and ch2["chosen"] == ch2["takes"][-1]["n"]
    assert ch2["takes"][-1]["edit"]["old_text"] == ch["text"] and ch2["takes"][0]["text"] == ch["text"]
    import pytest
    from firevoice.service import FireVoiceError
    with pytest.raises(FireVoiceError):
        svc.render_edit(rid, ch["index"], new)          # unchanged text
    svc.render_lock(rid, ch["index"], True)
    with pytest.raises(FireVoiceError):
        svc.render_edit(rid, ch["index"], new + " now")  # locked
