"""Pronunciation dictionary, kept takes (compare, re-take, choose, lock) and subtitles."""
import pytest

from firevoice.dictionary import compile_rules, parse_rules
from firevoice.frontend.normalize import normalize
from firevoice.service import TTSRequest
from firevoice.subtitles import cues, srt, vtt
from firevoice.takestore import qa_words


# ------------------------------------------------------------------ dictionary
def test_rules_run_first_and_respect_case_and_whole_words():
    rules = compile_rules(parse_rules([{"match": "SQL", "say": "ess cue ell"}, {"match": "cat", "say": "kitty"},
                                       {"match": "kg", "say": "kilograms", "case": True}]))
    out = normalize("SQL and sql, a cat concatenates 5 kg not KG", rules=rules)
    assert out.startswith("ess cue ell and ess cue ell")     # beats the built-in "sequel"
    assert "kitty" in out and "concatenates" in out
    assert "kilograms" in out and "KG" in out
    assert normalize("Ayesha ne kaha", lang="ur", rules=compile_rules(parse_rules({"Ayesha": "Aa-ye-sha"}))) == "Aa-ye-sha ne kaha"


def test_dictionary_api(svc):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    c = TestClient(create_app(svc))
    r = c.post("/api/v1/dictionary", json={"match": "FireVoice", "say": "Fire Voice"})
    assert r.status_code == 201
    rid = r.json()["id"]
    d = c.get("/api/v1/dictionary").json()
    assert [x["match"] for x in d["rules"]] == ["FireVoice"] and any(b["match"] == "GPU" for b in d["builtin"])
    assert c.post("/api/v1/dictionary/test", json={"text": "This is FireVoice.", "engine": "null"}).json()["spoken"] == "This is Fire Voice."
    assert c.patch(f"/api/v1/dictionary/{rid}", json={"say": "Fyre Voys"}).json()["say"] == "Fyre Voys"
    assert c.post("/api/v1/dictionary", json={"match": "", "say": "x"}).status_code == 400
    assert c.put("/api/v1/dictionary", json={"rules": [{"match": "a", "say": "b"}, {"match": "c", "say": "d"}]}).status_code == 200
    assert len(c.get("/api/v1/dictionary").json()["rules"]) == 2
    assert c.delete("/api/v1/dictionary/nope").status_code == 404
    r = c.post("/api/v1/tts", json={"text": "Hi.", "engine": "null", "voice": "design:x", "dictionary": "not rules"})
    assert r.status_code == 400


# ------------------------------------------------------------------ takes
def test_qa_words_marks_missed_and_changed():
    q = qa_words("The quick brown fox jumps.", "the quick brawn fox")
    st = [w["status"] for w in q["words"]]
    assert st == ["ok", "ok", "changed", "ok", "missed"] and q["match"] == 0.6
    same = qa_words("This is Fire Voice, at forty two percent.", "This is FireVoice at 42%.")
    assert same["match"] == 1.0 and not same["extra"]


def test_kept_render_retake_choose_lock(svc):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    c = TestClient(create_app(svc))
    text = "The first passage is here for testing. [pause 300ms] And the second passage follows after a pause."
    r = c.post("/api/v1/tts", json={"text": text, "engine": "null", "voice": "design:x", "keep_takes": True, "candidates": 2,
                                    "format": "wav", "response": "json"})
    assert r.status_code == 200, r.text
    rid = r.json()["render_id"]
    assert rid
    m = c.get(f"/api/v1/renders/{rid}").json()
    assert len(m["chunks"]) == 2 and all(len(ch["takes"]) == 2 for ch in m["chunks"])
    assert any("pause" in p for p in m["plan"])
    base = c.get(f"/api/v1/renders/{rid}/audio", params={"format": "wav"})
    assert base.status_code == 200 and len(base.content) > 1000
    # a new take of passage 0 becomes the one used; passage 1 is locked and survives regenerate
    m = c.post(f"/api/v1/renders/{rid}/chunks/0/takes", json={"seed": 777}).json()
    ch0 = m["chunks"][0]
    assert len(ch0["takes"]) == 3 and ch0["chosen"] == 3 and ch0["takes"][-1]["seed"] == 777
    c.post(f"/api/v1/renders/{rid}/chunks/1/lock", json={"locked": True})
    before = c.get(f"/api/v1/renders/{rid}").json()["chunks"][1]["chosen"]
    m = c.post(f"/api/v1/renders/{rid}/regenerate", json={}).json()
    assert len(m["chunks"][0]["takes"]) == 4 and m["chunks"][1]["chosen"] == before
    assert c.post(f"/api/v1/renders/{rid}/chunks/0/choose", json={"take": 1}).json()["chunks"][0]["chosen"] == 1
    assert c.post(f"/api/v1/renders/{rid}/chunks/0/choose", json={"take": 99}).status_code == 404
    assert c.get(f"/api/v1/renders/{rid}/chunks/0/takes/2/audio").status_code == 200
    sub = c.get(f"/api/v1/renders/{rid}/subtitles", params={"format": "vtt"})
    assert sub.status_code == 200 and sub.text.startswith("WEBVTT") and "-->" in sub.text
    assert any(x["id"] == rid for x in c.get("/api/v1/renders").json()["renders"])
    assert c.delete(f"/api/v1/renders/{rid}").status_code == 200
    assert c.get(f"/api/v1/renders/{rid}").status_code == 404
    assert c.get("/api/v1/renders/..%5C..%5Cx").status_code == 404


def test_without_keep_takes_nothing_is_stored(svc):
    r = svc.tts(TTSRequest(text="Nothing to keep here.", engine="null", voice="design:x"))
    assert r.render_id is None and svc.render_list() == []


# ------------------------------------------------------------------ subtitles
def test_subtitle_cues():
    words = [{"text": t, "start": i * 0.4, "end": i * 0.4 + 0.3} for i, t in enumerate(
        "Hello there. This is a much longer sentence that goes on and on for quite a while, past the limit for one cue.".split())]
    cs = cues(words)
    assert cs[0]["text"] == "Hello there." or len(cs[0]["text"]) <= 84
    assert all(len(c["text"]) <= 84 and c["end"] > c["start"] for c in cs)
    assert all(a["end"] < b["start"] for a, b in zip(cs, cs[1:]))
    s = srt(words)
    assert s.startswith("1\n00:00:00,000 --> ") and "\n2\n" in s
    assert vtt(words).startswith("WEBVTT\n\n00:00:00.000 --> ")


def test_subtitles_route(svc):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    c = TestClient(create_app(svc))
    r = c.post("/api/v1/subtitles", json={"words": [{"text": "Hi.", "start": 0.1, "end": 0.5}], "format": "srt"})
    assert r.status_code == 200 and "Hi." in r.text
    assert c.post("/api/v1/subtitles", json={"words": [], "format": "ass"}).status_code == 400



def test_script_style_switches_reach_the_engine(make):
    from firevoice.frontend import parse
    from firevoice.styles import get_style
    s = make()
    base = get_style("conversational")
    chunks, _ = s._plan(parse("Hello there, friend of mine. [whisper] This is a secret between us. [normal] Back to the normal voice now.", "custom", 1.0),
                        base, base, "en", 1, {"passage_chars": 0})
    assert [c.style.name for c in chunks] == ["conversational", "asmr", "conversational"]
    chunks, _ = s._plan(parse("Calm words first, and slowly. [style horror] Then the dark part of the story.", "custom", 1.0), base, base, "en", 1, {})
    assert [c.style.name for c in chunks] == ["conversational", "horror"]
