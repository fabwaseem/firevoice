"""The service over HTTP: what the CLI commands call on a local FireVoice, served by a running `firevoice serve`.

`firevoice <command> --remote [URL]` swaps the local service for this object, so every command works the same against
another machine (a GPU box, the desktop app's backend) as it does locally. Methods take and return what the local
service does: audio comes back as float32 arrays (fetched as WAV), errors as FireVoiceError with the server's code.
Commands that are local by nature (serve, doctor, bench, judge, samples, showcase, audition) have no remote form.
"""
from __future__ import annotations

import io
import json
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np
import soundfile as sf

from .client import DEFAULT_URL, Client, ClientError


def _err(e: ClientError):
    from .service import FireVoiceError
    return FireVoiceError(e.code, e.message)


def _wav(data: bytes) -> tuple[np.ndarray, int]:
    a, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    return (a.mean(axis=1) if a.ndim > 1 else a), int(sr)


class RemoteService:
    def __init__(self, url: Optional[str] = None, token: Optional[str] = None):
        self.url = url or DEFAULT_URL
        self.c = Client(self.url, token)

    # -------------------------------------------------------------------- plumbing
    def close(self) -> None:
        pass

    def _call(self, method: str, path: str, *, json_body: Any = None, params: Optional[dict] = None, files=None, data=None, raw=False):
        try:
            r = self.c._check(self.c.http.request(method, path, json=json_body, params={k: v for k, v in (params or {}).items() if v is not None},
                                                  files=files, data=data))
        except ClientError as e:
            raise _err(e)
        except Exception as e:
            from .service import FireVoiceError
            raise FireVoiceError("unavailable", f"cannot reach the server at {self.url}: {e}")
        return r if raw else r.json()

    def _upload(self, path, field: str = "file") -> dict:
        p = Path(path)
        return {field: (p.name, p.read_bytes())}

    @staticmethod
    def encode(*a, **kw):
        from .service import FireVoice
        return FireVoice.encode(*a, **kw)

    @staticmethod
    def subtitles(words, fmt: str = "srt") -> tuple[str, str]:
        from .subtitles import render
        return render(words, fmt)

    # -------------------------------------------------------------------- dictionary
    def dictionary_view(self) -> dict:
        return self._call("GET", "/api/v1/dictionary")

    def dictionary_add(self, rule: dict) -> dict:
        return self._call("POST", "/api/v1/dictionary", json_body=rule)

    def dictionary_remove(self, rule_id: str) -> dict:
        return self._call("DELETE", f"/api/v1/dictionary/{rule_id}")

    def dictionary_replace(self, rules: list) -> dict:
        return self._call("PUT", "/api/v1/dictionary", json_body={"rules": rules})

    def dictionary_test(self, text: str, engine: Optional[str] = None, language: Optional[str] = None, dictionary=None) -> dict:
        return self._call("POST", "/api/v1/dictionary/test", json_body={"text": text, "engine": engine, "language": language, "dictionary": dictionary})

    # -------------------------------------------------------------------- kept renders
    def render_list(self, limit: int = 50) -> list[dict]:
        return self._call("GET", "/api/v1/renders", params={"limit": limit})["renders"]

    def render_get(self, rid: str) -> dict:
        return self._call("GET", f"/api/v1/renders/{rid}")

    def render_audio(self, rid: str) -> tuple:
        a, sr = _wav(self._call("GET", f"/api/v1/renders/{rid}/audio", params={"format": "wav"}, raw=True).content)
        words = self._call("GET", f"/api/v1/renders/{rid}/words").get("words", [])
        return a, sr, words

    def render_retake(self, rid: str, index: int, seed: Optional[int] = None, choose: bool = True, cancel=None) -> dict:
        return self._call("POST", f"/api/v1/renders/{rid}/chunks/{index}/takes", json_body={"seed": seed, "choose": choose})

    def render_edit(self, rid: str, index: int, text: str, mode: str = "splice", seed: Optional[int] = None, cancel=None) -> dict:
        return self._call("POST", f"/api/v1/renders/{rid}/chunks/{index}/edit", json_body={"text": text, "mode": mode, "seed": seed})

    def render_choose(self, rid: str, index: int, n: int) -> dict:
        return self._call("POST", f"/api/v1/renders/{rid}/chunks/{index}/choose", json_body={"take": n})

    def render_lock(self, rid: str, index: int, locked: bool) -> dict:
        return self._call("POST", f"/api/v1/renders/{rid}/chunks/{index}/lock", json_body={"locked": locked})

    def render_regenerate(self, rid: str, indexes: Optional[list[int]] = None, cancel=None) -> dict:
        return self._call("POST", f"/api/v1/renders/{rid}/regenerate", json_body={"chunks": indexes})

    def render_delete(self, rid: str) -> dict:
        return self._call("DELETE", f"/api/v1/renders/{rid}")

    def render_quality(self, rid: str) -> dict:
        return self._call("GET", f"/api/v1/renders/{rid}/quality")

    # -------------------------------------------------------------------- styles
    def style_list(self) -> list[dict]:
        r = self._call("GET", "/api/v1/styles")
        return r["styles"] if isinstance(r, dict) else r

    def style(self, name: str) -> dict:
        return self._call("GET", f"/api/v1/styles/{name}")

    def style_save(self, data: dict) -> dict:
        return self._call("PUT", f"/api/v1/styles/{data['name']}", json_body=data)

    def style_remove(self, name: str) -> dict:
        return self._call("DELETE", f"/api/v1/styles/{name}")

    # -------------------------------------------------------------------- audio tools, voice changer, sound
    def audio_separate(self, path, mode: str = "vocals", priority: int = 0, cancel=None) -> tuple:
        import zipfile
        r = self._call("POST", "/api/v1/audio/separate", files=self._upload(path), data={"mode": mode, "stem": "zip", "format": "wav"}, raw=True)
        z = zipfile.ZipFile(io.BytesIO(r.content))
        names = z.namelist()
        voice, sr = _wav(z.read(next(n for n in names if n.startswith("voice"))))
        rest, _ = _wav(z.read(next(n for n in names if not n.startswith("voice"))))
        return voice, rest, sr

    def audio_analyze(self, path) -> dict:
        return self._call("POST", "/api/v1/audio/analyze", files=self._upload(path))

    def audio_detect(self, path) -> dict:
        return self._call("POST", "/api/v1/audio/detect", files=self._upload(path))

    def quality_report(self, path, voice: Optional[str] = None) -> dict:
        return self._call("POST", "/api/v1/audio/quality", files=self._upload(path), data={"voice": voice or ""})

    def audio_clean(self, path, strength: str = "medium") -> tuple:
        r = self._call("POST", "/api/v1/audio/clean", files=self._upload(path), data={"strength": strength, "format": "wav"}, raw=True)
        a, sr = _wav(r.content)
        check = {"before": json.loads(r.headers.get("X-Quality-Before") or "null"), "after": json.loads(r.headers.get("X-Quality-After") or "null")}
        return a, sr, check

    def voice_convert(self, source_path, voice: str, *, lufs: Optional[float] = -16.0, priority: int = 0, cancel=None) -> tuple:
        r = self._call("POST", "/api/v1/voice-changer", files=self._upload(source_path), data={"voice": voice or "default", "format": "wav"}, raw=True)
        return _wav(r.content)

    def sound(self, prompt: str, kind: str = "sfx", duration: float = 5.0, seed: Optional[int] = None, *, engine: Optional[str] = None,
              params: Optional[dict] = None, priority: int = 0, cancel=None) -> tuple:
        t0 = time.time()
        r = self._call("POST", "/api/v1/sound", json_body={"prompt": prompt, "kind": kind, "duration": duration, "seed": seed, "engine": engine,
                                                            "params": params or {}, "format": "wav"}, raw=True)
        a, sr = _wav(r.content)
        return a, sr, {"engine": r.headers.get("X-Engine"), "kind": kind, "seed": int(r.headers.get("X-Seed") or 0),
                       "duration": float(r.headers.get("X-Duration") or len(a) / sr), "seconds": round(time.time() - t0, 2),
                       "prompt": prompt, "license": r.headers.get("X-License")}

    # -------------------------------------------------------------------- dialogue and dubbing
    def dialogue_parse(self, script: str, cast: Optional[dict] = None) -> dict:
        return self._call("POST", "/api/v1/dialogue/parse", json_body={"script": script, "cast": cast})

    def dialogue(self, script: str, *, cast: Optional[dict] = None, defaults: Optional[dict] = None, gap_ms: int = 350,
                 lufs: Optional[float] = -16.0, seed: int = 1234, priority: int = 0, cancel=None, on_turn=None) -> dict:
        import base64
        r = self._call("POST", "/api/v1/dialogue", json_body={"script": script, "cast": cast, "defaults": defaults, "gap_ms": gap_ms, "lufs": lufs,
                                                               "seed": seed, "format": "wav", "response": "json", "stems": True})
        a, sr = _wav(base64.b64decode(r["audio_base64"]))
        stems = {n: _wav(base64.b64decode(b))[0] for n, b in (r.get("stems") or {}).items()}
        return {"audio": a, "sr": sr, "stems": stems, "turns": r["turns"], "words": r["words"], "cast": r["cast"]}

    @staticmethod
    def dialogue_subtitles(turns: list[dict], fmt: str = "srt") -> str:
        from .service import FireVoice
        return FireVoice.dialogue_subtitles(None, turns, fmt)

    def dub(self, path, target: str, *, source: Optional[str] = None, voice: Optional[str] = None, cast: Optional[dict] = None,
            keep_voices: bool = False, consent: bool = False, diarize: bool = False, speakers: Optional[int] = None,
            engine: Optional[str] = None, style: str = "conversational", background: float = 0.0, lufs: Optional[float] = -16.0,
            translator: Optional[str] = None, keep_music: bool = False, progress=None, cancel=None, priority: int = 1) -> dict:
        form = {"target_language": target, "source_language": source or "auto", "voice": voice or "", "cast": json.dumps(cast) if cast else "",
                "keep_voices": str(bool(keep_voices)).lower(), "consent": str(bool(consent)).lower(), "speakers": str(speakers or 0),
                "engine": engine or "", "style": style, "background": str(background), "format": "wav", "video": "false",
                "translator": translator or "fast", "keep_music": str(bool(keep_music)).lower()}
        job = self._call("POST", "/api/v1/dub", files=self._upload(path), data=form)
        while True:
            j = self._call("GET", f"/api/v1/jobs/{job['id']}")
            if progress and j.get("message"):
                progress("render", int(1000 * (j.get("progress") or 0)), 1000, j["message"])
            if j["status"] in ("done", "failed", "cancelled"):
                break
            if cancel is not None and cancel.is_set():
                self._call("POST", f"/api/v1/jobs/{job['id']}/cancel")
            time.sleep(1.5)
        if j["status"] != "done":
            from .service import FireVoiceError
            err = j.get("error") or {}
            raise FireVoiceError(err.get("code", "internal") if isinstance(err, dict) else "internal",
                                 (err.get("message") if isinstance(err, dict) else str(err)) or f"dub {j['status']}")
        a, sr = _wav(self._call("GET", f"/api/v1/jobs/{job['id']}/files/{j['result']['audio']}", raw=True).content)
        lines = self._call("GET", f"/api/v1/jobs/{job['id']}/files/lines.json")
        return {"audio": a, "sr": sr, **lines}

    # -------------------------------------------------------------------- projects
    def project_list(self) -> list[dict]:
        r = self._call("GET", "/api/v1/projects")
        return r["projects"] if isinstance(r, dict) else r

    def project_get(self, pid: str) -> dict:
        return self._call("GET", f"/api/v1/projects/{pid}")

    def project_create(self, title: str, text: str = "", defaults: Optional[dict] = None) -> dict:
        return self._call("POST", "/api/v1/projects", json_body={"title": title, "text": text, "defaults": defaults})

    def project_delete(self, pid: str) -> dict:
        return self._call("DELETE", f"/api/v1/projects/{pid}")

    def project_todo(self, pid: str, scope: str = "stale", chapter: Optional[str] = None) -> list[tuple[str, str]]:
        from .projects import status
        p = self.project_get(pid)
        out = []
        for ch in p["chapters"]:
            if chapter and ch["id"] != chapter:
                continue
            for para in ch["paragraphs"]:
                st = para.get("status") or status(p, para)
                if not para["text"].strip() or st == "locked":
                    continue
                if scope == "all" or st in ("draft", "stale"):
                    out.append((ch["id"], para["id"]))
        return out

    def paragraph_render(self, pid: str, para_id: str, priority: int = 0, cancel=None) -> dict:
        return self._call("POST", f"/api/v1/projects/{pid}/paragraphs/{para_id}/render")

    def paragraph_lock(self, pid: str, para_id: str, locked: bool) -> dict:
        return self._call("POST", f"/api/v1/projects/{pid}/paragraphs/{para_id}/lock", json_body={"locked": locked})

    def project_export(self, pid: str, fmt: str = "mp3", chapter: Optional[str] = None, master: Optional[str] = None,
                       allow_missing: bool = False) -> tuple[bytes, str, str]:
        r = self._call("GET", f"/api/v1/projects/{pid}/export", params={"format": fmt, "chapter": chapter, "master": master,
                                                                          "allow_missing": str(allow_missing).lower()}, raw=True)
        name = (r.headers.get("content-disposition", "").split("filename=")[-1].strip('"') or f"{pid}.{fmt}")
        return r.content, r.headers.get("content-type", ""), name

    def project_check(self, pid: str, master: Optional[str] = None) -> dict:
        return self._call("GET", f"/api/v1/projects/{pid}/check", params={"master": master})

    def project_bundle(self, pid: str) -> tuple[bytes, str]:
        r = self._call("GET", f"/api/v1/projects/{pid}/bundle", raw=True)
        return r.content, (r.headers.get("content-disposition", "").split("filename=")[-1].strip('"') or f"{pid}.fvproject.zip")

    def project_import(self, data: bytes) -> dict:
        return self._call("POST", "/api/v1/projects/import", files={"file": ("project.fvproject.zip", data)})

    # -------------------------------------------------------------------- whole renders (batch)
    def tts(self, req, on_chunk=None, cancel=None, priority: int = 0):
        """A Render-like object for batch: audio, sr, info()."""
        from .types import Result, Word
        body = {k: v for k, v in req.to_dict().items() if v is not None}
        r = self._call("POST", "/api/v1/tts", json_body={**body, "format": "wav", "response": "json"})
        import base64
        a, sr = _wav(base64.b64decode(r["audio_base64"]))
        words = [Word(w["text"], w["start"], w["end"]) for w in r.get("words", [])]
        info = {k: v for k, v in r.items() if k != "audio_base64"}

        class _R:
            audio, result = a, Result(a, sr, words)
            render_id = r.get("render_id")

            def __init__(self):
                self.sr = sr
                self.warnings = r.get("warnings", [])

            def info(self):
                return info
        return _R()
