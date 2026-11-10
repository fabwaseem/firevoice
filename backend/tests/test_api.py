"""HTTP API: every route group against the null engine (no GPU, no Whisper)."""
import io
import json
import time

import numpy as np
import pytest
import soundfile as sf

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402

from firevoice.server import create_app  # noqa: E402

DESIGN = "design:a calm test voice"


def wav_bytes(seconds=6.0, sr=24000):
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    a = (0.2 * np.sin(2 * np.pi * 180 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))).astype("float32")
    buf = io.BytesIO()
    sf.write(buf, a, sr, format="WAV")
    return buf.getvalue()


@pytest.fixture
def c(svc):
    return TestClient(create_app(svc))


def sse_events(text):
    out = []
    for block in text.strip().split("\n\n"):
        data = [l[5:].strip() for l in block.splitlines() if l.startswith("data:")]
        if data:
            out.append(json.loads("\n".join(data)))
    return out


def test_health_system_options(c):
    assert c.get("/health").json()["ok"]
    s = c.get("/api/v1/system").json()
    assert s["default_engine"] == "null" and "gpu" in s and "jobs" in s
    o = c.get("/api/v1/options").json()
    names = {e["name"] for e in o["engines"]}
    assert {"voxcpm2", "chatterbox-turbo", "omnivoice"} <= names
    vox = next(e for e in o["engines"] if e["name"] == "voxcpm2")
    assert {p["name"] for p in vox["params"]} == {"cfg_value", "inference_timesteps", "ultimate"} and vox["design"] and vox["instruct"]
    assert "mp3" in o["formats"] and o["defaults"]["style"] == "conversational" and len(o["styles"]) >= 21


def test_engines(c):
    assert len(c.get("/api/v1/engines").json()["engines"]) >= 10
    e = c.get("/api/v1/engines/voxcpm").json()   # alias
    assert e["name"] == "voxcpm2" and "ready" in e
    r = c.get("/api/v1/engines/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    assert c.post("/api/v1/engines/null/load", json={"workers": 1}).json()["loaded"]
    assert c.post("/api/v1/engines/null/unload").json()["loaded"] is False


def test_voices_crud(c):
    assert c.get("/api/v1/voices").json()["voices"] == []
    files = {"file": ("me.wav", wav_bytes(), "audio/wav")}
    r = c.post("/api/v1/voices", files=files, data={"name": "me", "consent": "false"})
    assert r.status_code == 400 and "consent" in r.json()["error"]["message"]
    r = c.post("/api/v1/voices", files=files, data={"name": "me", "consent": "true", "gender": "male", "language": "en", "transcript": "a test",
                                                    "tags": "mine,test"})
    assert r.status_code == 201, r.text
    v = r.json()
    assert v["voice_id"] == "me" and v["transcript"] == "a test" and v["kind"] == "cloned" and set(v["tags"]) == {"mine", "test"}
    assert c.post("/api/v1/voices", files=files, data={"name": "me", "consent": "true", "transcript": "x"}).status_code == 409
    assert c.get("/api/v1/voices", params={"gender": "male"}).json()["voices"][0]["voice_id"] == "me"
    assert c.get("/api/v1/voices", params={"gender": "female"}).json()["voices"] == []
    assert c.patch("/api/v1/voices/me", json={"description": "my voice", "favorite": True}).json()["description"] == "my voice"
    assert c.patch("/api/v1/voices/me", json={"voice_id": "x"}).status_code == 400
    assert c.put("/api/v1/voices/me/transcript", json={"transcript": "new words"}).json()["transcript"] == "new words"
    a = c.get("/api/v1/voices/me/audio")
    assert a.status_code == 200 and a.headers["content-type"] == "audio/wav" and len(a.content) > 1000
    assert c.post("/api/v1/voices/me/default").json()["default"]
    r = c.post("/api/v1/voices/me/styles/horror", files={"file": ("w.wav", wav_bytes(), "audio/wav")}, data={"transcript": "boo"})
    assert r.status_code == 200 and "horror" in r.json()["styles"]
    assert c.get("/api/v1/voices/me/audio", params={"style": "horror"}).status_code == 200
    assert c.delete("/api/v1/voices/me").json()["removed"]
    assert c.get("/api/v1/voices/me").status_code == 404


def test_voice_design_sync_and_job(c):
    v = c.post("/api/v1/voices/design", json={"name": "robo", "description": "a flat robot", "engine": "null"}).json()
    assert v["kind"] == "designed" and v["has_ref"] and v["description"] == "a flat robot"
    j = c.post("/api/v1/voices/design?wait=false", json={"name": "robo2", "description": "another robot", "engine": "null"}).json()
    done = wait_job(c, j["id"])
    assert done["status"] == "done" and done["result"]["voice"]["voice_id"] == "robo2"


def test_styles(c):
    names = {s["name"] for s in c.get("/api/v1/styles").json()["styles"]}
    assert {"horror", "explainer", "storyteller"} <= names
    s = c.put("/api/v1/styles/my-style", json={"title": "Mine", "pace": 1.1, "instruct": "warmly"}).json()
    assert s["name"] == "my-style" and s["builtin"] is False and s["pace"] == 1.1
    assert c.get("/api/v1/styles/my-style").json()["instruct"] == "warmly"
    assert c.put("/api/v1/styles/bad", json={"nonsense": 1}).status_code == 400
    assert c.delete("/api/v1/styles/horror").status_code == 400
    assert c.delete("/api/v1/styles/my-style").json()["removed"]
    assert c.get("/api/v1/styles/my-style").status_code == 404


def test_tts_formats_and_json(c):
    for fmt, ctype in (("wav", "audio/wav"), ("mp3", "audio/mpeg"), ("flac", "audio/flac"), ("ogg", "audio/ogg")):
        r = c.post("/api/v1/tts", json={"text": "Hello there, this is a test.", "voice": DESIGN, "format": fmt, "validate": False})
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith(ctype) and len(r.content) > 500 and float(r.headers["x-duration"]) > 0
    r = c.post("/api/v1/tts", json={"text": "Hello there, this is a test.", "voice": DESIGN, "format": "wav", "sample_rate": 16000, "validate": False})
    assert sf.info(io.BytesIO(r.content)).samplerate == 16000
    j = c.post("/api/v1/tts", json={"text": "Hello there. Second sentence here.", "voice": DESIGN, "response": "json", "validate": False,
                                    "style": "storyteller", "pace": 1.1, "style_overrides": {"pause": 1.3}, "lufs": None}).json()
    assert j["audio_base64"] and j["words"] and j["engine"] == "null" and j["style"] == "storyteller"


def test_tts_errors(c):
    cases = [({"text": ""}, 400), ({"text": "hi", "voice": DESIGN, "style": "nope"}, 404), ({"text": "hi", "voice": "ghost"}, 404),
             ({"text": "hi", "engine": "voxcpm2", "voice": DESIGN, "params": {"cfg_value": 99}}, 400), ({"text": "hi", "unknown_field": 1}, 400),
             ({"text": "hi", "voice": DESIGN, "style_overrides": {"bogus": 1}}, 400), ({"text": "hi", "pace": 9}, 400),
             ({"text": "hi", "engine": "chatterbox-turbo", "voice": DESIGN}, 400), ({"text": "hi", "voice": DESIGN, "format": "aiff"}, 400)]
    for body, status in cases:
        r = c.post("/api/v1/tts", json=body)
        assert r.status_code == status, (body, r.status_code, r.text)
        assert r.json()["error"]["message"]


def test_tts_stream_sse_and_pcm(c):
    text = "First sentence of the stream. Second sentence of the stream. Third sentence, and then the end."
    r = c.post("/api/v1/tts/stream", json={"text": text, "voice": DESIGN, "format": "wav", "validate": False})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    evs = sse_events(r.text)
    chunks = [e for e in evs if e["type"] == "chunk"]
    assert chunks and evs[-1]["type"] == "done" and evs[-1]["engine"] == "null"
    assert [e["index"] for e in chunks] == sorted(e["index"] for e in chunks) and chunks[0]["audio_base64"]
    bad = c.post("/api/v1/tts/stream", json={"text": "hi", "voice": DESIGN, "style": "nope"})
    assert bad.status_code == 404
    p = c.post("/api/v1/tts/stream.pcm", json={"text": text, "voice": DESIGN, "validate": False})
    assert p.status_code == 200 and int(p.headers["x-sample-rate"]) > 0 and len(p.content) > 1000 and len(p.content) % 2 == 0


def test_stt_route(c, svc, monkeypatch):
    monkeypatch.setattr(svc, "transcribe", lambda path, sr=None, language=None, beam_size=5, **kw: {"text": "hello", "language": language or "auto", "words": []})
    r = c.post("/api/v1/stt", files={"file": ("a.wav", wav_bytes(), "audio/wav")}, data={"language": "en"})
    body = r.json()
    hid = body.pop("history_id")
    assert r.status_code == 200 and body == {"text": "hello", "language": "en", "words": []}
    kept = c.get(f"/api/v1/history/{hid}").json()             # the transcript is kept in History
    assert kept["kind"] == "transcript" and {"audio", "transcript.json", "transcript.srt"} <= set(kept["files"])
    assert c.post("/api/v1/stt", files={"file": ("a.wav", b"", "audio/wav")}).status_code == 400


def wait_job(c, jid, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = c.get(f"/api/v1/jobs/{jid}").json()
        if j["status"] in ("done", "failed", "cancelled"):
            return j
        time.sleep(0.1)
    raise AssertionError(f"job {jid} did not finish")


def test_jobs_tts_batch_events(c):
    j = c.post("/api/v1/jobs", json={"kind": "tts", "payload": {"request": {"text": "A job line. And another.", "voice": DESIGN, "validate": False},
                                                                  "format": "mp3"}}).json()
    assert j["status"] == "queued" and j["title"]
    done = wait_job(c, j["id"])
    assert done["status"] == "done" and done["progress"] == 1.0 and done["result"]["audio"] == "audio.mp3"
    a = c.get(f"/api/v1/jobs/{j['id']}/audio")
    assert a.status_code == 200 and a.headers["content-type"] == "audio/mpeg"
    assert c.get(f"/api/v1/jobs/{j['id']}/files/words.json").status_code == 200
    assert c.get(f"/api/v1/jobs/{j['id']}/files/..%2F..%2Fsecret").status_code == 404
    evs = sse_events(c.get(f"/api/v1/jobs/{j['id']}/events").text)
    assert evs[-1]["type"] == "done" and evs[-1]["job"]["id"] == j["id"]
    b = c.post("/api/v1/jobs", json={"kind": "batch", "payload": {"lines": [{"id": "a", "text": "Line a here."}, {"id": "b", "text": "Line b here.",
                                     "style": "calm"}], "defaults": {"voice": DESIGN, "validate": False}, "format": "wav"}}).json()
    bd = wait_job(c, b["id"])
    assert bd["status"] == "done" and bd["result"]["files"] == ["a.wav", "b.wav"] and bd["result"]["failed"] == 0
    listing = c.get("/api/v1/jobs").json()
    assert {x["id"] for x in listing["jobs"]} >= {j["id"], b["id"]} and listing["counts"]["done"] >= 2
    assert c.delete(f"/api/v1/jobs/{j['id']}").json()["deleted"]
    assert c.get(f"/api/v1/jobs/{j['id']}").status_code == 404


def test_job_validation_and_cancel(c, svc):
    assert c.post("/api/v1/jobs", json={"kind": "tts", "payload": {"request": {"text": "hi", "style": "nope", "voice": DESIGN}}}).status_code == 404
    assert c.post("/api/v1/jobs", json={"kind": "batch", "payload": {"lines": []}}).status_code == 400
    assert c.post("/api/v1/jobs", json={"kind": "render", "payload": {}}).status_code == 400
    # hold both job threads busy with slow jobs, then cancel a queued one
    slow = {"request": {"text": "Slow. " * 40, "voice": DESIGN, "validate": False, "params": {"delay": 0.05}}, "format": "wav"}
    ids = [c.post("/api/v1/jobs", json={"kind": "tts", "payload": slow}).json()["id"] for _ in range(3)]
    r = c.post(f"/api/v1/jobs/{ids[-1]}/cancel").json()
    assert r["status"] in ("cancelled", "running")
    final = [wait_job(c, i, timeout=120)["status"] for i in ids]
    assert "cancelled" in final or all(s == "done" for s in final)


def test_auth(svc):
    c = TestClient(create_app(svc, token="s3cret"))
    assert c.get("/health").status_code == 200
    r = c.get("/api/v1/voices")
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorized"
    assert c.get("/api/v1/voices", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    assert c.get("/api/v1/voices", headers={"x-api-key": "s3cret"}).status_code == 200
    assert c.get("/v1/voices", headers={"xi-api-key": "s3cret"}).status_code == 200
    assert c.get("/api/v1/voices", params={"token": "s3cret"}).status_code == 200


def test_elevenlabs_compat(c):
    r = c.post("/v1/text-to-speech/default", json={"text": "Hello world, this is a test.", "voice_settings": {"stability": 0.4, "style": 0.6}})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and len(r.content) > 1000
    j = c.post("/v1/text-to-speech/default/with-timestamps", json={"text": "Hello world, this is a test."}).json()
    assert j["audio_base64"] and j["words"] and len(j["alignment"]["characters"]) > 5
    assert c.post("/v1/text-to-speech/nobody", json={"text": "hi there friend"}).status_code == 404
    assert c.get("/v1/voices").json()["voices"][0]["voice_id"] == "default"
    assert any(m["model_id"] == "voxcpm2" for m in c.get("/v1/models").json())


def test_docs_and_playground(c):
    assert c.get("/docs").status_code == 200 and "swagger" in c.get("/docs").text.lower()
    spec = c.get("/openapi.json").json()
    tts = spec["paths"]["/api/v1/tts"]["post"]
    examples = tts["requestBody"]["content"]["application/json"]["examples"]
    assert {"simple", "designed voice", "engine settings"} <= set(examples)
    assert "HTTPBearer" in spec["components"]["securitySchemes"]
    assert {t["name"] for t in spec["tags"]} >= {"tts", "voices", "jobs"}
    p = c.get("/playground")
    assert p.status_code == 200 and "FireVoice" in p.text and "/web/app.js" in p.text
    js = c.get("/web/app.js")
    assert js.status_code == 200 and "/api/v1/options" in js.text
    assert c.get("/web/app.css").status_code == 200
    assert c.get("/web/fonts/urbanist-latin-normal.woff2").status_code == 200
    assert c.get("/", follow_redirects=False).headers["location"] == "/playground"


def test_playground_files_revalidate_and_samples_ship(svc):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    c = TestClient(create_app(svc))
    r = c.get("/web/app.js")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-cache"
    for name in ("speech.mp3", "conversation.mp3", "speech-with-music.mp3"):
        s = c.get(f"/api/v1/samples/{name}")
        assert s.status_code == 200 and len(s.content) > 10_000 and s.headers["content-type"] == "audio/mpeg", name
    assert {x["name"] for x in c.get("/api/v1/samples").json()["samples"]} >= {"speech.mp3", "conversation.mp3"}
    assert c.get("/api/v1/samples/..%2Fapp.js").status_code == 404 and c.get("/api/v1/samples/nope.mp3").status_code == 404


def test_desktop_backend_serves_api_and_docs_but_no_playground(svc, monkeypatch):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    monkeypatch.setenv("FIREVOICE_DESKTOP", "1")
    c = TestClient(create_app(svc))
    assert c.get("/playground").status_code == 404 and c.get("/web/app.js").status_code == 404
    assert c.get("/", follow_redirects=False).headers["location"] == "/docs"
    assert c.get("/docs").status_code == 200 and c.get("/openapi.json").status_code == 200
    assert c.get("/api/v1/samples/speech.mp3").status_code == 200        # the app's Try a sample buttons still work
    from firevoice import API_VERSION
    assert c.get("/health").json()["api_version"] == API_VERSION
    monkeypatch.delenv("FIREVOICE_DESKTOP")
    c2 = TestClient(create_app(svc))
    assert c2.get("/playground").status_code == 200 and c2.get("/", follow_redirects=False).headers["location"] == "/playground"
    assert TestClient(create_app(svc, playground=False)).get("/playground").status_code == 404


def test_cors_exposes_history_id(c):
    # the desktop app reads X-History-Id after a separation; without exposing it, the browser hides it and the app
    # runs the separation twice
    r = c.get("/health", headers={"Origin": "http://localhost:1420"})
    assert "X-History-Id" in r.headers.get("access-control-expose-headers", "")


def test_tts_refuses_engines_that_cannot_read_text(c):
    # the voice changer engine reads no text; it used to come back silent (and a dialogue then came out as loud noise)
    r = c.post("/api/v1/tts", json={"text": "Hello there.", "engine": "chatterbox-vc"})
    assert r.status_code == 400
    assert "doesn't read text" in r.json()["error"]["message"]
    r = c.post("/api/v1/dialogue", json={"script": "A: Hi.\nB: Hello.", "defaults": {"engine": "chatterbox-vc"}})
    assert r.status_code == 400
