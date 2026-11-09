"""--remote: the CLI's service calls served over HTTP return what the local service returns."""
import numpy as np
import pytest


@pytest.fixture
def remote(svc):
    from fastapi.testclient import TestClient

    from firevoice.remote import RemoteService
    from firevoice.server import create_app
    r = RemoteService("http://testserver")
    r.c.http = TestClient(create_app(svc))
    return r


def test_dictionary_and_styles(remote):
    remote.dictionary_add({"match": "SQL", "say": "sequel"})
    assert any(x["match"] == "SQL" for x in remote.dictionary_view()["rules"])
    assert "sequel" in remote.dictionary_test("I like SQL.")["spoken"]
    assert any(s["name"] == "conversational" for s in remote.style_list())


def test_tts_and_kept_render(remote):
    from firevoice.service import TTSRequest
    r = remote.tts(TTSRequest(text="Hello there, a kept render over HTTP.", engine="null", keep_takes=True))
    assert r.sr > 0 and len(r.audio) > 0 and r.render_id
    a, sr, words = remote.render_audio(r.render_id)
    assert isinstance(a, np.ndarray) and sr > 0
    assert remote.render_get(r.render_id)["id"] == r.render_id
    assert any(x["id"] == r.render_id for x in remote.render_list())


def test_errors_keep_their_code(remote):
    from firevoice.service import FireVoiceError
    with pytest.raises(FireVoiceError) as e:
        remote.render_get("nope-not-here")
    assert e.value.code == "not_found"


def test_projects(remote):
    p = remote.project_create("Remote book", "# One\n\nFirst paragraph here.\n\nSecond one.")
    assert remote.project_todo(p["id"]) and remote.project_get(p["id"])["title"] == "Remote book"
    data, name = remote.project_bundle(p["id"])
    assert data[:2] == b"PK" and name.endswith(".zip")
