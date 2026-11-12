"""Dictation's memory: your words, replacements and snippets act on what is said, and every dictation is kept."""
import pytest
from fastapi.testclient import TestClient

from firevoice.dictation_store import DictationStore
from firevoice.dictation_text import format_words
from test_dictation import Script, speech


def test_words_replacements_and_snippets_shape_the_text(tmp_path):
    st = DictationStore(tmp_path)
    st.set_words(["FireVoice", "Kubernetes", "firevoice", " "])
    assert st.load()["words"] == ["FireVoice", "Kubernetes"]                  # duplicates (any case) and blanks dropped
    st.save_replacement({"heard": "wazeem", "write": "Waseem"})
    st.save_snippet({"trigger": "my email", "text": "me@example.com"})
    st.save_snippet({"trigger": "My Email", "text": "new@example.com"})       # the same trigger: changed, not added
    assert len(st.load()["snippets"]) == 1
    rules = st.rules()
    said = "hi wazeem we deploy firevoice on kubernetes comma reach me at my email".split()
    assert format_words(said, rules=rules) == "hi Waseem we deploy FireVoice on Kubernetes, reach me at new@example.com"
    assert "FireVoice" in st.hotwords() and "Waseem" in st.hotwords()
    rid = st.load()["replacements"][0]["id"]
    assert st.delete("replacements", rid) and not st.delete("replacements", rid)
    with pytest.raises(ValueError):
        st.save_snippet({"trigger": "  ", "text": "x"})


def test_history_is_searchable_newest_first_and_deletable(tmp_path):
    st = DictationStore(tmp_path)
    a = st.record("Book the flight to Lisbon", 3.0, "en", app="Outlook")
    st.record("Lunch at noon", 1.5, "en")
    assert st.record("   ", 1.0) is None
    h = st.history()
    assert [r["text"] for r in h["items"]] == ["Lunch at noon", "Book the flight to Lisbon"]
    assert h["total"] == 2 and h["words"] == 8
    assert [r["text"] for r in st.history("lisbon FLIGHT")["items"]] == ["Book the flight to Lisbon"]
    assert st.delete_history(a["id"]) == 1 and st.history()["total"] == 1
    assert st.delete_history() == 1 and st.history()["total"] == 0


def test_a_polished_dictation_applies_corrections_and_is_kept(svc):
    from firevoice.server import create_app
    svc._aligner.transcribe_window = Script("meet on tuesday no wait friday thanks wazeem")
    c = TestClient(create_app(svc))
    assert c.post("/api/v1/dictation/replacements", json={"heard": "wazeem", "write": "Waseem"}).status_code == 200
    assert c.post("/api/v1/dictation/snippets", json={"trigger": "sign off", "text": "Best,\nW"}).json()["trigger"] == "sign off"
    # one dictionary: the replacement's word is a word too
    assert c.post("/api/v1/dictation/words", json={"word": "FireVoice"}).json()["words"] == ["Waseem", "FireVoice"]
    with c.websocket_connect("/api/v1/dictate") as ws:
        ws.send_json({"type": "start", "language": "en", "sample_rate": 16000, "refine": True, "app": "Slack"})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes((speech(3.6) * 32767).astype("<i2").tobytes())
        ws.send_json({"type": "stop"})
        while (m := ws.receive_json())["type"] not in ("final", "error"):
            pass
    assert m["type"] == "final" and m["replace"] is True
    assert m["text"] == "Meet on friday thanks Waseem", m["text"]
    h = c.get("/api/v1/dictation/history").json()
    assert h["items"][0]["text"] == m["text"] and h["items"][0]["app"] == "Slack" and m["history_id"] == h["items"][0]["id"]
    assert c.get("/api/v1/dictation/history", params={"q": "waseem"}).json()["total"] == 1
    assert c.delete("/api/v1/dictation/history").json()["deleted"] == 1
    v = c.get("/api/v1/dictation/vocabulary").json()
    assert v["words"] == ["Waseem", "FireVoice"] and v["replacements"][0]["write"] == "Waseem" and v["snippets"][0]["text"] == "Best,\nW"
    # it is all in the dictionary, which the voices use too (a word with no "say it as" is not read differently)
    d = c.get("/api/v1/dictionary").json()["rules"]
    assert [(r["match"], r["say"], r["heard"]) for r in d] == [("Waseem", "", ["wazeem"]), ("FireVoice", "", [])]
    assert c.post("/api/v1/dictionary/test", json={"text": "Waseem uses FireVoice"}).json()["spoken"].startswith("Waseem uses")
    # taking a misheard form away leaves the word
    assert c.delete(f"/api/v1/dictation/replacements/{v['replacements'][0]['id']}").status_code == 200
    assert c.get("/api/v1/dictation/vocabulary").json()["replacements"] == []


def test_without_a_gpu_other_languages_get_a_multilingual_model(svc, monkeypatch):
    import firevoice.asr as asr
    made = []

    class FakeAligner:
        def __init__(self, model, device="auto", concurrency=2, language="en"):
            self.model_name = model
            made.append(model)

        def transcribe_window(self, *a, **k):
            return [], None

        def detect_language(self, audio):
            return []

    monkeypatch.setattr(asr, "FasterWhisperAligner", FakeAligner)
    svc._aligner.model_name = "base.en"                      # the English-only model used without an NVIDIA card
    assert svc.dictation_aligner("en", None) is svc._aligner
    assert svc.dictation_aligner(None, ["en"]) is svc._aligner
    ml = svc.dictation_aligner(None, ["en", "ur"])
    assert ml is not svc._aligner and made == ["small"]
    assert svc.dictation_aligner("de", None) is ml and made == ["small"]          # loaded once
    svc._aligner.model_name = "large-v3-turbo"                 # with a GPU the shared model knows every language
    assert svc.dictation_aligner("de", None) is svc._aligner


def test_only_certain_languages_teach_the_profile(tmp_path):
    st = DictationStore(tmp_path)
    st.record("hola que tal amigo", 3, "es", language_probability=0.93)
    st.record("hello there friend", 3, "en", language_chosen=True)
    st.record("o que esta fazendo", 3, "pt", language_probability=0.41)       # a weak guess: not a habit
    st.record("old entry without certainty", 3, "de")
    st.record("mera naam waseem hai", 3, "hi", language_probability=0.95)     # Urdu or Hindi: the script was a pick, not heard
    assert st.language_profile() == {"es": 0.5, "en": 0.5}
    st.record("mera naam waseem hai", 3, "ur", language_chosen=True)          # chosen by the speaker: that teaches
    assert st.language_profile()["ur"] > 0


def test_dictation_words_and_replacements_move_into_the_dictionary_once(tmp_path):
    import json
    from firevoice.dictionary import Dictionary
    from firevoice.service import FireVoice
    (tmp_path / "dictation.json").write_text(json.dumps({
        "words": ["Kubernetes", "Siobhan"],
        "replacements": [{"id": "a", "heard": "wazeem", "write": "Waseem"}, {"id": "b", "heard": "fire voice", "write": "FireVoice"}],
        "snippets": [{"id": "s", "trigger": "my email", "text": "me@example.com"}],
    }), encoding="utf-8")
    Dictionary(tmp_path / "dictionary.json").add({"match": "Siobhan", "say": "Shi-vawn"})
    svc = FireVoice.__new__(FireVoice)
    svc.dictionary = Dictionary(tmp_path / "dictionary.json")
    svc.dictation_store = DictationStore(tmp_path)
    svc._fold_dictation_words()
    rules = {r["match"]: r for r in svc.dictionary.rules()}
    assert set(rules) == {"Siobhan", "Kubernetes", "Waseem", "FireVoice"}
    assert rules["Siobhan"]["say"] == "Shi-vawn"                  # what was there is kept
    assert rules["Waseem"]["heard"] == ["wazeem"] and rules["FireVoice"]["heard"] == ["fire voice"]
    left = svc.dictation_store.load()
    assert left["words"] == [] and left["replacements"] == [] and left["snippets"][0]["trigger"] == "my email"
    svc._fold_dictation_words()                                   # nothing more to move
    assert len(svc.dictionary.rules()) == 4


def test_dictation_is_counted_for_home(tmp_path):
    import time
    st = DictationStore(tmp_path)
    st.record("Hello there this is a test of five", 3.0, "en", app="slack.exe")      # 8 words
    st.record("Another short one", 2.0, "en", app="C:\Program Files\Code.exe")
    st.record("Translated words here", 2.0, "ur", app="slack.exe", mode="translation")
    s = st.stats(30)
    assert s["count"] == 3 and s["words"] == 14 and s["seconds"] == 7.0
    assert s["wpm"] == 120                                       # 14 words in 7 seconds
    assert s["saved_s"] == round(14 / 40 * 60 - 7)              # typing them would take 21 s
    assert s["apps"][0] == {"key": "Slack", "name": "Slack", "count": 2, "words": 11} and s["apps"][1]["name"] == "VS Code"
    assert s["translations"] == 1 and s["streak"] == 1 and s["daily"][0]["words"] == 14
    assert s["all_time"]["count"] == 3 and s["longest_words"] == 8
    assert DictationStore(tmp_path / "empty").stats(7)["count"] == 0
