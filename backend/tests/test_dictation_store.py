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
    assert c.post("/api/v1/dictation/words", json={"word": "FireVoice"}).json()["words"] == ["FireVoice"]
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
    assert v["words"] == ["FireVoice"] and v["replacements"][0]["write"] == "Waseem" and v["snippets"][0]["text"] == "Best,\nW"
