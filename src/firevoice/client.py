"""Small Python client for a running FireVoice server (used by `firevoice ... --remote URL`, scripts and tests).

    from firevoice.client import Client
    c = Client("http://127.0.0.1:8787")
    audio = c.tts("Hello there.", voice="lib-f-4992", style="storyteller", format="mp3")
    for ev in c.tts_stream("A longer paragraph..."):   # chunk events as they are ready
        ...
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any, Iterator, Optional

DEFAULT_URL = os.environ.get("FIREVOICE_URL", "http://127.0.0.1:8787")


class ClientError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message = status, code, message


class Client:
    def __init__(self, url: str = DEFAULT_URL, token: Optional[str] = None, timeout: float = 3600.0):
        import httpx
        self.url = url.rstrip("/")
        h = {"Authorization": f"Bearer {token or os.environ.get('FIREVOICE_API_KEY')}"} if (token or os.environ.get("FIREVOICE_API_KEY")) else {}
        self.http = httpx.Client(base_url=self.url, headers=h, timeout=timeout)

    def _check(self, r):
        if r.status_code >= 400:
            try:
                e = r.json()["error"]
                raise ClientError(r.status_code, e.get("code", "error"), e.get("message", r.text))
            except (ValueError, KeyError, TypeError):
                raise ClientError(r.status_code, "error", r.text[:300])
        return r

    def get(self, path: str, **params) -> Any:
        return self._check(self.http.get(path, params={k: v for k, v in params.items() if v is not None})).json()

    def post(self, path: str, json_body: Optional[dict] = None, **kw) -> Any:
        return self._check(self.http.post(path, json=json_body, **kw)).json()

    # -- convenience ----------------------------------------------------------------
    def health(self) -> dict:
        return self.get("/health")

    def alive(self) -> bool:
        try:
            return bool(self.health().get("ok"))
        except Exception:
            return False

    def engines(self) -> list[dict]:
        return self.get("/api/v1/engines")["engines"]

    def voices(self, **filters) -> list[dict]:
        return self.get("/api/v1/voices", **filters)["voices"]

    def styles(self) -> list[dict]:
        return self.get("/api/v1/styles")["styles"]

    def tts(self, text: str, **opts) -> tuple[bytes, dict]:
        """-> (audio bytes, info headers). opts: any TTS request field plus format / sample_rate."""
        r = self._check(self.http.post("/api/v1/tts", json={"text": text, **opts}))
        info = {k[2:].lower().replace("-", "_"): v for k, v in r.headers.items() if k.lower().startswith("x-")}
        return r.content, info

    def tts_json(self, text: str, **opts) -> dict:
        return self.post("/api/v1/tts", {"text": text, **opts, "response": "json"})

    def tts_stream(self, text: str, **opts) -> Iterator[dict]:
        """Server-sent events from /api/v1/tts/stream; chunk events carry `audio` (bytes) decoded from base64."""
        with self.http.stream("POST", "/api/v1/tts/stream", json={"text": text, **opts}) as r:
            if r.status_code >= 400:
                r.read()
                self._check(r)
            event, data = None, []
            for line in r.iter_lines():
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data.append(line[5:].strip())
                elif not line and data:
                    ev = json.loads("\n".join(data))
                    if ev.get("audio_base64") is not None:
                        ev["audio"] = base64.b64decode(ev.pop("audio_base64"))
                    yield ev
                    event, data = None, []

    def stt(self, path: str | Path, language: str = "auto", beam_size: int = 5) -> dict:
        p = Path(path)
        with p.open("rb") as f:
            return self._check(self.http.post("/api/v1/stt", files={"file": (p.name, f)}, data={"language": language, "beam_size": str(beam_size)})).json()

    def job(self, kind: str, payload: dict, title: str = "") -> dict:
        return self.post("/api/v1/jobs", {"kind": kind, "payload": payload, "title": title})
