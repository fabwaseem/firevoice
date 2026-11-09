"""Background jobs: long renders, batches and voice design, with progress events and an on-disk history.

Every job lives in ~/.firevoice/renders/<id>/ (job.json + outputs), so the history survives a restart; a job that
was queued or running when the process stopped is marked failed ("interrupted"). Events are kept in one ordered
log with sequence numbers, so a client can subscribe to everything (`events()`) or to one job, and resume after a
reconnect by passing the last sequence number it saw.

Kinds and payloads
  tts     {"request": TTSRequest fields, "format": "mp3", "sample_rate": null}
  batch   {"lines": [{"id": "l1", "text": "...", <any TTSRequest field>}...], "defaults": {TTSRequest fields}, "format": "wav"}
  design  {"name": "...", "description": "...", "engine": null, "text": null, "gender": "", "language": ""}
  previews {"voices": null (all) or ["id", ...], "engine": null, "force": false}   branded "Hi, I'm ..." clip per voice
"""
from __future__ import annotations

import json
import queue
import re
import shutil
import threading
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterator, Optional

TERMINAL = ("done", "failed", "cancelled")
KINDS = ("tts", "batch", "design", "previews", "project", "style_refs", "dialogue", "install", "dub")
OWN_THREAD = ("install",)   # long, GPU-free work that must not hold up renders queued behind it


@dataclass
class Job:
    id: str
    kind: str
    title: str
    payload: dict
    status: str = "queued"
    created: float = field(default_factory=time.time)
    started: Optional[float] = None
    finished: Optional[float] = None
    progress: float = 0.0
    step: int = 0
    steps: int = 0
    message: str = ""
    error: Optional[dict] = None
    result: dict = field(default_factory=dict)

    def view(self) -> dict:
        d = asdict(self)
        d["elapsed"] = round((self.finished or time.time()) - self.started, 2) if self.started else None
        return d


class JobManager:
    def __init__(self, service, root: Optional[Path] = None, concurrency: int = 2, keep_events: int = 5000):
        from .service import home
        self.svc = service
        self.root = Path(root or home() / "renders")
        self.root.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, Job] = {}
        self.cancels: dict[str, threading.Event] = {}
        self.q: "queue.Queue[Optional[str]]" = queue.Queue()
        self.lock = threading.RLock()
        self.cond = threading.Condition(self.lock)
        self.events_log: deque = deque(maxlen=keep_events)
        # Event numbers start at the current time in milliseconds, so they keep growing across server restarts: a
        # client resuming with an old `since` (or Last-Event-ID) gets every event of the new run, never silence.
        self.seq = int(time.time() * 1000)
        self._load_history()
        self.threads = [threading.Thread(target=self._loop, daemon=True, name=f"fv-job-{i}") for i in range(max(1, concurrency))]
        for t in self.threads:
            t.start()

    # -------------------------------------------------------------------- public
    def submit(self, kind: str, payload: dict, title: str = "") -> dict:
        from .service import FireVoiceError, TTSRequest
        if kind not in KINDS:
            raise FireVoiceError("bad_request", f"unknown job kind {kind!r}; use one of {', '.join(KINDS)}")
        # validate up front so a bad request fails at submit time, not minutes later
        if not isinstance(payload, dict):
            raise FireVoiceError("bad_request", "payload must be an object")
        if kind == "tts":
            req = TTSRequest.from_dict(payload.get("request") or {})
            self.svc.prepare(req)
            _check_format(payload.get("format", "mp3"))
            title = title or _title(req.text)
        elif kind == "batch":
            lines = payload.get("lines") or []
            if not isinstance(lines, list) or not all(isinstance(l, dict) for l in lines):
                raise FireVoiceError("bad_request", "batch lines must be a list of objects like {\"id\": ..., \"text\": ...}")
            if not isinstance(payload.get("defaults") or {}, dict):
                raise FireVoiceError("bad_request", "batch defaults must be an object")
            if not lines:
                raise FireVoiceError("bad_request", "batch needs at least one line")
            ids = [str(l.get("id") or i + 1) for i, l in enumerate(lines)]
            if len(set(ids)) != len(ids):
                raise FireVoiceError("bad_request", "batch line ids must be unique")
            for l in lines:
                self.svc.prepare(TTSRequest.from_dict({**(payload.get("defaults") or {}), **{k: v for k, v in l.items() if k != "id"}}))
            _check_format(payload.get("format", "wav"))
            title = title or f"batch of {len(lines)} lines"
        elif kind == "design":
            if not payload.get("name") or not payload.get("description"):
                raise FireVoiceError("bad_request", "design needs a name and a description")
            title = title or f"design voice {payload['name']}"
        elif kind == "previews":
            title = title or f"voice previews ({len(payload.get('voices') or []) or 'all'})"
        elif kind == "dialogue":
            info = self.svc.dialogue_parse(str(payload.get("script") or ""), payload.get("cast"))
            _check_format(payload.get("format", "mp3"))
            title = title or f"dialogue: {', '.join(info['speakers'][:4])} ({len(info['turns'])} turns)"
        elif kind == "style_refs":
            v = self.svc.voice(str(payload.get("voice") or ""))
            styles = payload.get("styles") or []
            if not isinstance(styles, list) or not styles:
                raise FireVoiceError("bad_request", "style_refs needs a voice and a list of styles")
            title = title or f"{v.get('name') or v['voice_id']}: {len(styles)} style clip(s)"
        elif kind == "project":
            p = self.svc.project_get(str(payload.get("project") or ""))
            if payload.get("scope", "stale") not in ("stale", "all"):
                raise FireVoiceError("bad_request", "scope must be 'stale' (drafts and changed paragraphs) or 'all' (everything not locked)")
            todo = self.svc.project_todo(p["id"], payload.get("scope", "stale"), payload.get("chapter"))
            if not todo:
                raise FireVoiceError("conflict", "nothing to render: every paragraph is rendered and up to date (or locked)")
            title = title or f"{p['title']}: {len(todo)} paragraph(s)"
        elif kind == "dub":
            from . import translate
            from .paths import home
            src = Path(str(payload.get("input") or "")).resolve()
            uploads = (home() / "uploads").resolve()
            if uploads not in src.parents or not src.is_file():
                raise FireVoiceError("bad_request", "dub jobs take an uploaded file (POST /api/v1/dub)")
            if not translate.supported(str(payload.get("target") or "")):
                raise FireVoiceError("bad_request", f"cannot dub into {payload.get('target')!r}")
            if payload.get("keep_voices") and not payload.get("consent"):
                raise FireVoiceError("bad_request", "keeping the original voices needs consent")
            _check_format(payload.get("format", "mp3"))
            title = title or f"dub into {payload['target']}: {payload.get('name') or src.name}"
        elif kind == "install":
            from . import installer
            try:
                m = installer.manifest(str(payload.get("engine") or ""))
            except (KeyError, ValueError) as e:
                raise FireVoiceError("not_found", str(e).strip("'\""))
            if not m.auto:
                raise FireVoiceError("bad_request", f"{m.engine} cannot be installed automatically: {m.manual}")
            if not installer.uv():
                raise FireVoiceError("unavailable", "uv not found: install uv or the backend's server extra, which includes it")
            busy = [x for x in self.jobs.values() if x.kind == "install" and x.status not in TERMINAL
                    and installer.MANIFESTS.get(x.payload.get("engine"), m).venv == m.venv]
            if busy:
                raise FireVoiceError("conflict", f"{m.venv} is already being installed (job {busy[0].id})")
            payload = {**payload, "engine": m.engine}
            title = title or f"install {m.engine}"
        job = Job(id=time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6], kind=kind, title=title, payload=payload)
        with self.lock:
            self.jobs[job.id] = job
            self.cancels[job.id] = threading.Event()
            self._save(job)
            self._emit(job, "queued")
        if kind in OWN_THREAD:
            threading.Thread(target=self._execute, args=(job.id,), daemon=True, name=f"fv-{kind}-{job.id}").start()
        else:
            self.q.put(job.id)
        return job.view()

    def list(self, status: Optional[str] = None, kind: Optional[str] = None, limit: int = 100) -> list[dict]:
        with self.lock:
            js = sorted(self.jobs.values(), key=lambda j: -j.created)
        return [j.view() for j in js if (not status or j.status == status) and (not kind or j.kind == kind)][:limit]

    def get(self, job_id: str) -> dict:
        return self._job(job_id).view()

    def cancel(self, job_id: str) -> dict:
        j = self._job(job_id)
        with self.lock:
            if j.status in TERMINAL:
                return j.view()
            self.cancels[job_id].set()
            if j.status == "queued":
                self._finish(j, "cancelled", message="cancelled before it started")
        return j.view()

    def delete(self, job_id: str) -> dict:
        from .service import FireVoiceError
        j = self._job(job_id)
        if j.status not in TERMINAL:
            raise FireVoiceError("conflict", "cancel the job before deleting it")
        with self.lock:
            self.jobs.pop(job_id, None)
            self.cancels.pop(job_id, None)
            self._emit(j, "deleted")        # other open clients drop it from their lists too
        shutil.rmtree(self.root / job_id, ignore_errors=True)
        return {"id": job_id, "deleted": True}

    def file(self, job_id: str, name: Optional[str] = None) -> Path:
        """Path of a job output (default: the main audio file)."""
        from .service import FireVoiceError
        j = self._job(job_id)
        name = name or j.result.get("audio")
        if not name:
            raise FireVoiceError("not_found", f"job {job_id} has no audio (status {j.status})")
        p = (self.root / job_id / name).resolve()
        if self.root.resolve() not in p.parents or not p.exists():
            raise FireVoiceError("not_found", f"no file {name!r} in job {job_id}")
        return p

    def events(self, since: int = 0, job_id: Optional[str] = None, timeout: float = 15.0) -> Iterator[dict]:
        """Yield events with seq > since; a {"type": "ping"} every `timeout` seconds of silence. For one job the
        stream ends after its terminal event."""
        last = since
        while True:
            with self.cond:
                new = [e for e in self.events_log if e["seq"] > last and (job_id is None or e["job"]["id"] == job_id)]
                if not new:
                    self.cond.wait(timeout)
                    new = [e for e in self.events_log if e["seq"] > last and (job_id is None or e["job"]["id"] == job_id)]
            if not new:
                yield {"type": "ping", "seq": last}
                if job_id and self._job(job_id).status in TERMINAL:
                    return
                continue
            for e in new:
                last = e["seq"]
                yield e
                if job_id and e["job"]["status"] in TERMINAL:
                    return

    def counts(self) -> dict:
        with self.lock:
            c: dict = {}
            for j in self.jobs.values():
                c[j.status] = c.get(j.status, 0) + 1
            return c

    def close(self) -> None:
        with self.lock:
            for jid, j in self.jobs.items():
                if j.status not in TERMINAL:
                    self.cancels[jid].set()
        for _ in self.threads:
            self.q.put(None)

    # -------------------------------------------------------------------- internals
    def _job(self, job_id: str) -> Job:
        from .service import FireVoiceError
        with self.lock:
            j = self.jobs.get(job_id)
        if j is None:
            raise FireVoiceError("not_found", f"unknown job {job_id!r}")
        return j

    def _emit(self, j: Job, typ: str) -> None:
        with self.cond:
            self.seq += 1
            self.events_log.append({"seq": self.seq, "type": typ, "time": time.time(), "job": j.view()})
            self.cond.notify_all()

    def _save(self, j: Job) -> None:
        d = self.root / j.id
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "job.json.tmp"
        tmp.write_text(json.dumps(j.view(), indent=1, ensure_ascii=False, default=str), encoding="utf-8")
        tmp.replace(d / "job.json")

    def _load_history(self) -> None:
        for f in sorted(self.root.glob("*/job.json")):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
                d.pop("elapsed", None)
                j = Job(**d)
            except Exception as e:
                import sys
                sys.stderr.write(f"[firevoice] skipped unreadable job record {f}: {e}\n")
                continue
            if j.status not in TERMINAL:
                j.status, j.finished = "failed", time.time()
                j.error = {"code": "interrupted", "message": "the server stopped while this job was queued or running"}
                self._save(j)
            self.jobs[j.id] = j
            self.cancels[j.id] = threading.Event()

    def _progress(self, j: Job, step: int, steps: int, message: str = "") -> None:
        with self.lock:
            j.step, j.steps = step, steps
            j.progress = round(min(1.0, step / steps), 4) if steps else 0.0
            if message:
                j.message = message
            self._emit(j, "progress")

    def _finish(self, j: Job, status: str, message: str = "", error: Optional[dict] = None) -> None:
        with self.lock:
            j.status, j.finished = status, time.time()
            if status == "done":
                j.progress = 1.0
            j.message = message or j.message
            j.error = error
            self._save(j)
            self._emit(j, status)

    def _loop(self) -> None:
        while True:
            jid = self.q.get()
            if jid is None:
                return
            self._execute(jid)

    def _execute(self, jid: str) -> None:
        from .service import FireVoiceError
        from .types import Cancelled
        try:
            j = self._job(jid)
        except Exception:
            return
        cancel = self.cancels.get(jid) or threading.Event()
        if j.status != "queued" or cancel.is_set():
            return
        with self.lock:
            j.status, j.started = "running", time.time()
            self._save(j)
            self._emit(j, "running")
        try:
            getattr(self, f"_run_{j.kind}")(j, cancel)
            self._finish(j, "done", message="finished")
        except Cancelled:
            self._finish(j, "cancelled", message="cancelled")
        except FireVoiceError as e:
            self._finish(j, "failed", error={"code": e.code, "message": e.message})
        except Exception as e:  # noqa: BLE001
            self._finish(j, "failed", error={"code": "internal", "message": f"{type(e).__name__}: {str(e)[:400]}"})

    def _run_tts(self, j: Job, cancel: threading.Event) -> None:
        from .service import TTSRequest
        p = j.payload
        req = TTSRequest.from_dict(p.get("request") or {})
        fmt = p.get("format", "mp3")
        r = self.svc.tts(req, on_chunk=lambda c: self._progress(j, c["index"] + (0 if c.get("final") else 1), max(1, c["total"]),
                                                               message=f"sentence {min(c['index'] + 1, c['total'])} of {c['total']}"), cancel=cancel, priority=1)
        d = self.root / j.id
        name = f"audio.{_ext(fmt)}"
        (d / name).write_bytes(self.svc.encode(r, fmt, p.get("sample_rate")))
        info = r.info()
        (d / "words.json").write_text(json.dumps(info.pop("words"), indent=1), encoding="utf-8")
        j.result = {"audio": name, "words": "words.json", "format": fmt, **info}

    def _run_batch(self, j: Job, cancel: threading.Event) -> None:
        from .service import FireVoiceError, TTSRequest
        from .types import Cancelled
        p = j.payload
        fmt = p.get("format", "wav")
        lines = p["lines"]
        d = self.root / j.id
        manifest, failed = [], 0
        for i, line in enumerate(lines):
            if cancel.is_set():
                raise Cancelled("cancelled")
            lid = _safe_name(str(line.get("id") or i + 1))
            self._progress(j, i, len(lines), message=f"line {i + 1} of {len(lines)}")
            req = TTSRequest.from_dict({**(p.get("defaults") or {}), **{k: v for k, v in line.items() if k != "id"}})
            try:
                r = self.svc.tts(req, cancel=cancel, priority=1)
            except FireVoiceError as e:
                failed += 1
                manifest.append({"id": lid, "text": req.text, "error": {"code": e.code, "message": e.message}})
                continue
            name = f"{lid}.{_ext(fmt)}"
            (d / name).write_bytes(self.svc.encode(r, fmt, p.get("sample_rate")))
            info = r.info()
            (d / f"{lid}.words.json").write_text(json.dumps(info.pop("words"), indent=1), encoding="utf-8")
            manifest.append({"id": lid, "text": req.text, "file": name, **info})
            (d / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
        self._progress(j, len(lines), len(lines))
        j.result = {"manifest": "manifest.json", "files": [m["file"] for m in manifest if "file" in m], "failed": failed,
                    "duration": round(sum(m.get("duration", 0) for m in manifest), 2), "audio": next((m["file"] for m in manifest if "file" in m), None)}

    def _run_previews(self, j: Job, cancel: threading.Event) -> None:
        from .types import Cancelled
        p = j.payload
        ids = p.get("voices") or [v["voice_id"] for v in self.svc.voice_list() if v.get("has_ref")]
        todo = [i for i in ids if p.get("force") or not (self.svc.voices.root / self.svc.voices.canonical(i) / "preview.mp3").exists()]
        done, failed = [], []
        for k, vid in enumerate(todo):
            if cancel.is_set():
                raise Cancelled("cancelled")
            self._progress(j, k, len(todo), message=f"{vid} ({k + 1} of {len(todo)})")
            try:
                self.svc.voice_render_preview(vid, engine=p.get("engine"), priority=1)
                done.append(vid)
            except Exception as e:  # noqa: BLE001  one bad voice never stops the batch
                failed.append({"voice": vid, "error": str(getattr(e, "message", e))[:200]})
        self._progress(j, len(todo), max(1, len(todo)))
        j.result = {"rendered": done, "failed": failed, "skipped": len(ids) - len(todo)}

    def _run_project(self, j: Job, cancel: threading.Event) -> None:
        """Render a project's drafts and changed paragraphs (or all unlocked ones), one by one, in the background."""
        from .service import FireVoiceError
        from .types import Cancelled
        p = j.payload
        todo = self.svc.project_todo(p["project"], p.get("scope", "stale"), p.get("chapter"))
        done, failed = [], []
        for k, (ch, para) in enumerate(todo):
            if cancel.is_set():
                raise Cancelled("cancelled")
            self._progress(j, k, len(todo), message=f"paragraph {k + 1} of {len(todo)}")
            try:
                self.svc.paragraph_render(p["project"], para, priority=1, cancel=cancel)
                done.append(para)
            except Cancelled:
                raise
            except FireVoiceError as e:
                failed.append({"paragraph": para, "chapter": ch, "error": e.message[:200]})
        self._progress(j, len(todo), max(1, len(todo)))
        j.result = {"project": p["project"], "rendered": len(done), "failed": failed}

    def _run_dialogue(self, j: Job, cancel: threading.Event) -> None:
        """A dialogue in the background: the mix, a stem per speaker, turns, words and subtitles in the job folder."""
        p = j.payload
        fmt = p.get("format", "mp3")
        d = self.svc.dialogue(p["script"], cast=p.get("cast"), defaults=p.get("defaults"), gap_ms=int(p.get("gap_ms", 350)), cancel=cancel,
                              priority=1, on_turn=lambda k, n: self._progress(j, k, n, message=f"turn {k} of {n}"))
        out = self.root / j.id
        (out / "stems").mkdir(parents=True, exist_ok=True)
        name = f"audio.{_ext(fmt)}"
        (out / name).write_bytes(self.svc.encode(d["audio"], fmt, sr=d["sr"]))
        stems = []
        for spk, a in d["stems"].items():
            fn = f"stems/{_safe_name(spk)}.{_ext(fmt)}"
            (out / fn).write_bytes(self.svc.encode(a, fmt, sr=d["sr"]))
            stems.append(fn)
        (out / "words.json").write_text(json.dumps(d["words"], indent=1), encoding="utf-8")
        (out / "turns.json").write_text(json.dumps({"turns": d["turns"], "cast": d["cast"]}, indent=1, ensure_ascii=False), encoding="utf-8")
        (out / "dialogue.srt").write_text(self.svc.dialogue_subtitles(d["turns"], "srt"), encoding="utf-8")
        j.result = {"audio": name, "stems": stems, "words": "words.json", "turns": "turns.json", "subtitles": "dialogue.srt", "format": fmt,
                    "duration": round(len(d["audio"]) / d["sr"], 2), "speakers": list(d["stems"])}

    def _run_dub(self, j: Job, cancel: threading.Event) -> None:
        """Dub the uploaded recording: the dubbed audio, subtitles, the lines (with timings) and, for a video, the video
        with the new soundtrack. The upload is deleted afterwards."""
        import shutil
        import subprocess

        from . import audio as A
        from . import dubbing
        p = j.payload
        fmt = p.get("format", "mp3")
        out = self.root / j.id
        out.mkdir(parents=True, exist_ok=True)
        stages = {"transcribe": (0.0, 0.15), "translate": (0.15, 0.3), "render": (0.3, 0.97)}

        def progress(stage, k, n, msg):
            lo, hi = stages.get(stage, (0.0, 1.0))
            self._progress(j, int(1000 * (lo + (hi - lo) * (k / n if n else 0))), 1000, msg)
        src = Path(p["input"])
        try:
            wav = src
            if src.suffix.lower() not in (".wav", ".flac"):
                wav = out / "source.wav"
                r = subprocess.run([A._ffmpeg(), "-y", "-v", "error", "-i", str(src), "-ac", "1", str(wav)], capture_output=True)
                if r.returncode != 0:
                    raise RuntimeError(f"cannot read the upload: {r.stderr.decode(errors='replace')[-300:]}")
            d = self.svc.dub(wav, p["target"], source=p.get("source"), voice=p.get("voice"), cast=p.get("cast"),
                             keep_voices=bool(p.get("keep_voices")), consent=bool(p.get("consent")), speakers=p.get("speakers"),
                             engine=p.get("engine"), style=p.get("style") or "conversational", background=float(p.get("background") or 0.0),
                             translator=p.get("translator"), progress=progress, cancel=cancel, priority=1)
            name = f"dub.{_ext(fmt)}"
            (out / name).write_bytes(self.svc.encode(d["audio"], fmt, sr=d["sr"]))
            for sub in ("srt", "vtt"):
                (out / f"dub.{sub}").write_text(dubbing.subtitles(d["lines"], sub), encoding="utf-8")
            (out / "lines.json").write_text(json.dumps({k: v for k, v in d.items() if k not in ("audio", "sr")}, indent=1, ensure_ascii=False),
                                            encoding="utf-8")
            files = [name, "dub.srt", "dub.vtt", "lines.json"]
            probe = subprocess.run([A._ffmpeg(), "-hide_banner", "-i", str(src)], capture_output=True)
            if p.get("video", True) and b"Video:" in probe.stderr and b"attached pic" not in probe.stderr:
                dub_wav = out / "dub_track.wav"
                import soundfile as sf
                sf.write(str(dub_wav), d["audio"], d["sr"], subtype="PCM_16")
                vid = out / f"dub{src.suffix if src.suffix.lower() in ('.mp4', '.mov', '.mkv') else '.mp4'}"
                r = subprocess.run([A._ffmpeg(), "-y", "-v", "error", "-i", str(src), "-i", str(dub_wav), "-map", "0:v:0", "-map", "1:a:0",
                                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", str(vid)], capture_output=True)
                dub_wav.unlink(missing_ok=True)
                if r.returncode == 0:
                    files.append(vid.name)
            (out / "source.wav").unlink(missing_ok=True)
            j.result = {"audio": name, "files": files, "format": fmt, "duration": round(len(d["audio"]) / d["sr"], 2),
                        "source_language": d["source_language"], "target_language": d["target_language"], "lines": len(d["lines"]),
                        "voices_kept": d["voices_kept"], "subtitles": "dub.srt", "translator": d["translator"]}
        finally:
            shutil.rmtree(src.parent, ignore_errors=True)

    def _run_install(self, j: Job, cancel: threading.Event) -> None:
        """Build an engine's venv and fetch its weights (installer.install); the full log is install.log."""
        from . import installer
        from .service import FireVoiceError
        from .types import Cancelled
        folder = self.root / j.id
        folder.mkdir(parents=True, exist_ok=True)
        try:
            j.result = installer.install(j.payload["engine"], lambda k, n, msg: self._progress(j, k, n, msg), cancel,
                                         log_file=folder / "install.log", force=bool(j.payload.get("force")))
        except installer.InstallCancelled:
            raise Cancelled("cancelled")
        except installer.InstallError as e:
            raise FireVoiceError("internal", f"{e} (full log: install.log)")
        j.result["files"] = ["install.log"]

    def _run_style_refs(self, j: Job, cancel: threading.Event) -> None:
        """Build a voice's own clip for each listed style, one by one."""
        from .service import FireVoiceError
        from .types import Cancelled
        p = j.payload
        done, failed = [], []
        for k, st in enumerate(p["styles"]):
            if cancel.is_set():
                raise Cancelled("cancelled")
            self._progress(j, k, len(p["styles"]), message=f"{st} ({k + 1} of {len(p['styles'])})")
            try:
                self.svc.voice_build_style_ref(p["voice"], st, engine=p.get("engine"), priority=1, cancel=cancel)
                done.append(st)
            except Cancelled:
                raise
            except FireVoiceError as e:
                failed.append({"style": st, "error": e.message[:200]})
        self._progress(j, len(p["styles"]), max(1, len(p["styles"])))
        j.result = {"voice": p["voice"], "built": done, "failed": failed}

    def _run_design(self, j: Job, cancel: threading.Event) -> None:
        p = j.payload
        self._progress(j, 0, 1, message="rendering the voice")
        v = self.svc.voice_design(p["name"], p["description"], engine=p.get("engine"), text=p.get("text"), gender=p.get("gender", ""),
                                  language=p.get("language", ""), seed=int(p.get("seed", 1234)))
        j.result = {"voice": v}


def _ext(fmt: str) -> str:
    from .audio import FORMATS
    return FORMATS[fmt][2]


def _check_format(fmt: str) -> None:
    from .audio import FORMATS
    from .service import FireVoiceError
    if fmt not in FORMATS:
        raise FireVoiceError("bad_request", f"unsupported format {fmt!r}; use one of {', '.join(FORMATS)}")


def _safe_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s)[:80] or "line"


def _title(text: str) -> str:
    t = " ".join(text.split())
    return t[:60] + ("…" if len(t) > 60 else "")
