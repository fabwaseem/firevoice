"""API reach: OpenAI-compatible speech and transcription, WebSocket text-in streaming, STT options, speaker labels."""
import io

import numpy as np
import soundfile as sf

from firevoice.diarize import label_speakers


def _client(svc):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    return TestClient(create_app(svc))


def test_openai_speech(svc):
    c = _client(svc)
    r = c.post("/v1/audio/speech", json={"model": "null", "input": "Hello there, this is a test.", "voice": "alloy", "response_format": "wav"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("audio/wav") and len(r.content) > 1000
    pcm = c.post("/v1/audio/speech", json={"model": "null", "input": "Hello.", "response_format": "pcm", "speed": 1.2})
    assert pcm.status_code == 200 and len(pcm.content) % 2 == 0
    aac = c.post("/v1/audio/speech", json={"model": "null", "input": "Hello.", "response_format": "aac", "extra_field_is_ignored": 1})
    assert aac.status_code == 200 and aac.headers["content-type"] == "audio/aac"


def test_openai_voice_mapping(svc, tmp_path):
    clip = tmp_path / "c.wav"
    sf.write(str(clip), (0.2 * np.sin(np.linspace(0, 3000, 24000 * 6))).astype("float32"), 24000)
    svc.voice_add("fem-a", clip, consent=True, gender="female", transcript="hi")
    svc.voice_add("man-a", clip, consent=True, gender="male", transcript="hi")
    assert svc.openai_voice("alloy") == "fem-a" and svc.openai_voice("onyx") == "man-a"
    assert svc.openai_voice("man-a") == "man-a"


def test_openai_transcriptions_formats(svc, monkeypatch):
    c = _client(svc)
    fake = {"text": "Hello there.", "language": "en", "duration": 1.2,
            "words": [{"text": "Hello", "start": 0.1, "end": 0.4}, {"text": "there.", "start": 0.4, "end": 0.9}],
            "segments": [{"start": 0.1, "end": 0.9, "text": "Hello there."}]}
    monkeypatch.setattr(svc, "transcribe", lambda *a, **k: fake)
    buf = io.BytesIO()
    sf.write(buf, np.zeros(24000, np.float32), 24000, format="WAV")
    up = {"file": ("a.wav", buf.getvalue(), "audio/wav")}
    assert c.post("/v1/audio/transcriptions", files=up, data={"model": "whisper-1"}).json() == {"text": "Hello there."}
    v = c.post("/v1/audio/transcriptions", files=up, data={"response_format": "verbose_json"}).json()
    assert v["words"][0] == {"word": "Hello", "start": 0.1, "end": 0.4} and v["segments"][0]["id"] == 0
    assert "-->" in c.post("/v1/audio/transcriptions", files=up, data={"response_format": "srt"}).text
    assert c.post("/api/v1/stt", files=up, data={"format": "text"}).text == "Hello there."


def test_speaker_labels_group_by_voice():
    sr = 16000
    segs = [{"start": i, "end": i + 1.0} for i in range(6)]
    a = np.zeros(sr * 7, np.float32)
    voice = {0: "A", 1: "B", 2: "A", 3: "A", 4: "B", 5: "C"}
    vecs = {"A": np.array([1.0, 0, 0]), "B": np.array([0, 1.0, 0]), "C": np.array([0.05, 0.99, 0.1])}
    calls = iter(range(6))
    emb = lambda x, sr: (lambda v: v / np.linalg.norm(v))(vecs[voice[next(calls)]])
    labels = label_speakers(a, sr, segs, embed=emb)
    assert labels == ["Speaker 1", "Speaker 2", "Speaker 1", "Speaker 1", "Speaker 2", "Speaker 2"]


def test_websocket_text_in_audio_out(svc):
    c = _client(svc)
    with c.websocket_connect("/api/v1/tts/ws") as ws:
        ws.send_json({"type": "config", "engine": "null", "voice": "design:a calm voice", "validate": False, "lufs": None, "format": "wav"})
        for piece in ["Hello there, this is the ", "first sentence of the stream. And here ", "comes a second one that ends now."]:
            ws.send_json({"type": "text", "text": piece})
        ws.send_json({"type": "end"})
        got, segments = [], set()
        while True:
            m = ws.receive_json()
            if m["type"] == "audio" and m["audio_base64"]:
                got.append(m)
            if m["type"] == "segment_done":
                segments.add(m["segment"])
            if m["type"] in ("done", "error"):
                break
        assert m["type"] == "done" and len(segments) == 2 and got
        assert {g["segment"] for g in got} == {0, 1}


def test_websocket_rejects_bad_config(svc):
    c = _client(svc)
    with c.websocket_connect("/api/v1/tts/ws") as ws:
        ws.send_json({"type": "config", "style": 5})
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"type": "end"})
        assert ws.receive_json()["type"] == "done"


def test_subtitles_break_on_speaker_and_label():
    from firevoice import subtitles
    w = [{"text": "Hello", "start": 0.0, "end": 0.4, "speaker": "Speaker 1"},
         {"text": "there", "start": 0.45, "end": 0.8, "speaker": "Speaker 1"},
         {"text": "Hi", "start": 0.85, "end": 1.1, "speaker": "Speaker 2"},
         {"text": "As", "start": 1.2, "end": 1.4, "speaker": "Speaker 2"},
         {"text": "-salamu", "start": 1.4, "end": 1.8, "speaker": "Speaker 2"}]
    cs = subtitles.cues(w)
    assert [c["speaker"] for c in cs] == ["Speaker 1", "Speaker 2"]
    assert cs[1]["text"] == "Hi As-salamu"
    srt = subtitles.srt(w)
    assert "Speaker 1: Hello there" in srt and "Speaker 2: Hi" in srt
    assert "<v Speaker 2>Hi As-salamu" in subtitles.vtt(w)
    assert "Speaker" not in subtitles.srt([{k: v for k, v in x.items() if k != "speaker"} for x in w])
