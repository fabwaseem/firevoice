"""FireVoice service: the one backend both the CLI and the HTTP API (and the desktop app) talk to.

    svc = FireVoice()
    r = svc.tts(TTSRequest(text="Hello there.", engine="voxcpm2", voice="lib-f-4992", style="storyteller"))
    open("hello.mp3", "wb").write(svc.encode(r, "mp3"))

Responsibilities
  * engines   catalog + status, lazy loading, VRAM-aware eviction of idle engines, explicit load/unload
  * tts       one validated request type (TTSRequest) for every engine, voice, style and engine parameter;
              whole-file renders, in-order streaming of sentence chunks, cancellation
  * stt       Whisper transcription with word times
  * voices    list / filter / add / update / remove / default / per-style refs / design-and-lock
  * styles    built-in + user styles, save and delete user styles
  * jobs      background renders with progress events, history on disk (see jobs.py)
"""
from __future__ import annotations

import dataclasses
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator, Optional

import numpy as np

from . import audio as A
from .core import catalog
from .core.registry import all_engines, get_engine
from .styles import STYLE_FIELDS, Style, all_styles, get_style, style_dict
from .types import Cancelled, Result
from .voices import VoiceLibrary

def home() -> Path:
    """FireVoice data folder (voices, styles, renders, logs): $FIREVOICE_HOME or ~/.firevoice, read at call time."""
    return Path(os.environ.get("FIREVOICE_HOME", Path.home() / ".firevoice"))


class FireVoiceError(Exception):
    """Errors with a stable code the API maps to HTTP status: bad_request 400, not_found 404, conflict 409,
    unavailable 503, internal 500."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ------------------------------------------------------------------------------------------------ request
@dataclass
class TTSRequest:
    text: str
    engine: Optional[str] = None            # default: the service default engine
    voice: str = "default"                  # library id, "default", or "design:<description>" / "design:<kokoro preset>"
    style: str = "conversational"           # any style name (see styles())
    pace: float = 1.0                       # tempo multiplier on top of the style's own pace
    seed: int = 1234
    language: Optional[str] = None          # ISO code; None = detect from the script
    instruct: Optional[str] = None          # delivery instruction; None = the style's, "" = none
    params: dict = field(default_factory=dict)            # engine-specific knobs (catalog schema)
    style_overrides: dict = field(default_factory=dict)   # any Style field: temperature, cfg, pause, exaggeration...
    lufs: Optional[float] = -16.0           # loudness target of the studio chain; None = raw
    candidates: int = 1                     # takes per sentence; the best validated one is kept
    accept: float = 0.9                     # ASR agreement a take needs to count as validated
    validate: bool = True                   # ASR-check takes (English) and retry bad ones
    lead_ms: int = 120
    tail_ms: int = 280
    dictionary: Optional[object] = None      # extra pronunciation rules for this request: [{match, say, ...}] or {written: spoken}
    keep_takes: bool = False                # store every take of every passage (see /api/v1/renders) to compare, swap, re-take

    @classmethod
    def from_dict(cls, d: dict) -> "TTSRequest":
        known = {f.name for f in dataclasses.fields(cls)}
        unknown = set(d) - known
        if unknown:
            raise FireVoiceError("bad_request", f"unknown request field(s): {', '.join(sorted(unknown))}")
        if not isinstance(d, dict):
            raise FireVoiceError("bad_request", "a request must be a JSON object")
        vals = {k: v for k, v in d.items() if v is not None or k in ("lufs", "instruct", "language")}
        # jobs and the CLI build requests from plain JSON: check types here the way pydantic does for /tts
        kinds = {"text": str, "engine": str, "voice": str, "style": str, "language": str, "instruct": str, "pace": float, "seed": int,
                 "lufs": float, "candidates": int, "accept": float, "validate": bool, "lead_ms": int, "tail_ms": int, "keep_takes": bool,
                 "params": dict, "style_overrides": dict}
        for k, v in list(vals.items()):
            want = kinds.get(k)
            if v is None or want is None:
                continue
            ok = isinstance(v, want) and not (want in (int, float) and isinstance(v, bool))
            if not ok and want is float and isinstance(v, int) and not isinstance(v, bool):
                vals[k], ok = float(v), True
            if not ok and want is int and isinstance(v, float) and v.is_integer():
                vals[k], ok = int(v), True
            if not ok:
                raise FireVoiceError("bad_request", f"field {k!r} must be {want.__name__}, got {type(v).__name__} {v!r}"[:200])
        if "text" not in vals or not str(vals["text"]).strip():
            raise FireVoiceError("bad_request", "field 'text' is required")
        return cls(**vals)

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


@dataclass
class Render:
    """A finished render: audio + word times + what was actually used."""
    result: Result
    request: TTSRequest
    engine: str
    seconds: float
    warnings: list = field(default_factory=list)
    render_id: Optional[str] = None          # set when the render was kept (keep_takes)

    @property
    def audio(self) -> np.ndarray:
        return self.result.audio

    @property
    def sr(self) -> int:
        return self.result.sr

    @property
    def duration(self) -> float:
        return self.result.duration

    def info(self) -> dict:
        st = getattr(self.result, "stats", None)
        return {"engine": self.engine, "voice": self.request.voice, "style": self.request.style, "duration": round(self.duration, 3),
                "sample_rate": self.sr, "seconds": round(self.seconds, 3), "rtf": getattr(st, "rtf", None), "chunks": getattr(st, "chunks", None),
                "takes": getattr(st, "takes", None), "retries": getattr(st, "retries", None), "cache_hits": getattr(st, "cache_hits", None),
                "warnings": self.warnings + list(self.result.warnings), "render_id": self.render_id,
                "words": [w.__dict__ for w in self.result.words]}


@dataclass
class _Loaded:
    name: str
    pool: object
    loaded_at: float
    last_used: float
    active: int = 0
    synths: dict = field(default_factory=dict)


# ------------------------------------------------------------------------------------------------ service
class FireVoice:
    def __init__(self, default_engine: Optional[str] = None, *, workers: Optional[dict] = None, asr_model: str = "auto", asr_device: str = "auto",
                 cache_dir: Optional[str] = None, lexicon: Optional[dict] = None, vram_reserve_gb: float = 2.0, max_text_chars: int = 200_000,
                 voices: Optional[VoiceLibrary] = None):
        self.default_engine = default_engine or os.environ.get("FIREVOICE_ENGINE", "voxcpm2")
        self.workers = workers or {}
        self.asr_model, self.asr_device = asr_model, asr_device
        self.cache_dir = cache_dir or os.environ.get("FIREVOICE_CACHE") or None
        self.lexicon = lexicon
        self.vram_reserve_gb = vram_reserve_gb
        self.max_text_chars = max_text_chars
        self.voices = voices or VoiceLibrary()
        self.voices.transcriber = lambda a, sr: self.aligner().transcribe_text(a, sr)[0]
        self._loaded: dict[str, _Loaded] = {}
        self._lock = threading.RLock()
        self._engine_locks: dict[str, threading.Lock] = {}
        self._aligner = None
        self._aligner_lock = threading.Lock()
        self.started = time.time()
        from .dictionary import Dictionary
        from .jobs import JobManager
        from .takestore import RenderStore
        self.dictionary = Dictionary(home() / "dictionary.json")
        self.renders = RenderStore(home() / "takes")
        self.jobs = JobManager(self)

    # -------------------------------------------------------------------- engines
    def engine_names(self) -> list[str]:
        return [n for n in all_engines() if n != "null"] if os.environ.get("FIREVOICE_HIDE_NULL", "1") == "1" else list(all_engines())

    def engines(self) -> list[dict]:
        return [self.engine(n) for n in self.engine_names()]

    def engine(self, name: str) -> dict:
        try:
            spec = get_engine(name)
        except ValueError as e:
            raise FireVoiceError("not_found", str(e))
        inf = catalog.info(spec.name)
        loaded = self._loaded.get(spec.name)
        d = {**inf.to_dict(), "name": spec.name, "license": spec.license, "commercial": spec.commercial, "vram_gb": spec.vram_gb,
             "default_workers": spec.default_workers, "description": spec.description, **inf.status(), "default": spec.name == self._resolve_engine(None),
             "loaded": loaded is not None}
        if loaded is not None:
            p = loaded.pool
            d.update(workers=len(p.workers), runtime_sample_rate=p.sr, active_requests=loaded.active, loaded_at=loaded.loaded_at, last_used=loaded.last_used,
                     boot_seconds=getattr(p, "boot_seconds", None), pool_stats=dict(p.stats), runtime_caps=p.caps,
                     broken=getattr(p, "broken", None))
        return d

    def _resolve_engine(self, name: Optional[str]) -> str:
        try:
            return get_engine(name or self.default_engine).name
        except ValueError as e:
            raise FireVoiceError("not_found", str(e))

    def load(self, name: Optional[str] = None, workers: Optional[int] = None) -> dict:
        """Load an engine now (otherwise the first request loads it). Idle engines are unloaded first when the GPU
        does not have room, because an oversubscribed card pages to system RAM and runs 10-30x slower."""
        n = self._resolve_engine(name)
        self._pool(n, workers)
        return self.engine(n)

    def unload(self, name: str) -> dict:
        n = self._resolve_engine(name)
        with self._lock:
            ld = self._loaded.get(n)
            if ld is None:
                return {"name": n, "loaded": False}
            if ld.active:
                raise FireVoiceError("conflict", f"engine {n} is busy with {ld.active} request(s)")
            self._loaded.pop(n)
        self._stop(ld)
        return {"name": n, "loaded": False}

    def _stop(self, ld: _Loaded) -> None:
        for s in ld.synths.values():
            try:
                s._scorers.shutdown(wait=False)
            except Exception:
                pass
        try:
            ld.pool.stop()
        except Exception:
            pass
        _free_cuda_cache()

    def _pool(self, name: str, workers: Optional[int] = None, hold: bool = False):
        """The loaded engine `name`, booting it if needed. `hold=True` also counts the caller as an active request in
        the same locked step, so no other request can unload the engine between finding it and using it (the caller
        must decrement `active` when done)."""
        from .core.pool import EnginePool

        def take(ld):
            if hold:
                ld.active += 1
                ld.last_used = time.time()
            return ld
        stale = None
        with self._lock:
            ld = self._loaded.get(name)
            if ld is not None and getattr(ld.pool, "broken", None) and ld.active == 0:
                stale = self._loaded.pop(name)      # every worker died: boot it again rather than fail forever
            elif ld is not None:
                return take(ld)
            elock = self._engine_locks.setdefault(name, threading.Lock())
        if stale is not None:
            self._stop(stale)
        with elock:   # one boot per engine even if many requests arrive at once
            with self._lock:
                if name in self._loaded:
                    return take(self._loaded[name])
            inf = catalog.info(name)
            st = inf.status()
            if not st["ready"]:
                raise FireVoiceError("unavailable", f"engine {name} is not installed: {'; '.join(st['problems'])}")
            spec = get_engine(name)
            want = workers or self.workers.get(name) or spec.default_workers
            self._make_room(spec.vram_gb * 1 + self.vram_reserve_gb, keep=name)
            pool = EnginePool(spec, workers=want)
            try:
                pool.start()
            except Exception as e:
                try:
                    pool.stop()
                except Exception:
                    pass
                raise FireVoiceError("unavailable", f"engine {name} failed to start: {str(e)[:400]}")
            now = time.time()
            ld = _Loaded(name, pool, now, now)
            with self._lock:
                self._loaded[name] = ld
                return take(ld)

    def _make_room(self, need_gb: float, keep: str) -> None:
        free = _free_vram_gb()
        if free is None or free >= need_gb:
            return
        with self._lock:
            idle = sorted((ld for n, ld in self._loaded.items() if n != keep and ld.active == 0), key=lambda ld: ld.last_used)
        for ld in idle:
            with self._lock:
                if self._loaded.get(ld.name) is not ld or ld.active:
                    continue
                self._loaded.pop(ld.name)
            self._stop(ld)
            free = _free_vram_gb() or 0
            if free >= need_gb:
                return

    def _synth(self, ld: _Loaded, validate: bool, candidates: int, accept: float):
        from .synth import Synthesizer
        key = (validate, candidates, round(accept, 3))
        with self._lock:
            s = ld.synths.get(key)
            if s is None:
                s = Synthesizer(ld.pool, self.aligner() if validate else _null_aligner(), self.voices, self.lexicon,
                                candidates=candidates, accept=accept, cache_dir=self.cache_dir)
                ld.synths[key] = s
            return s

    def aligner(self):
        """Shared Whisper model (validation + STT). Loaded once, lazily."""
        with self._aligner_lock:
            if self._aligner is None:
                from .asr import FasterWhisperAligner
                self._aligner = FasterWhisperAligner(self.asr_model, device=self.asr_device, concurrency=2)
            return self._aligner

    # -------------------------------------------------------------------- tts
    def prepare(self, req: TTSRequest) -> tuple[str, Style, dict, list[str]]:
        """Validate a request without rendering: -> (engine, style, engine params, warnings)."""
        warn: list[str] = []
        if not isinstance(req.text, str) or not req.text.strip():
            raise FireVoiceError("bad_request", "text is empty")
        if len(req.text) > self.max_text_chars:
            raise FireVoiceError("bad_request", f"text is {len(req.text)} characters; the limit is {self.max_text_chars} (use a job for long scripts)")
        eng = self._resolve_engine(req.engine)
        inf = catalog.info(eng)
        try:
            from .dictionary import parse_rules
            parse_rules(req.dictionary)
        except ValueError as e:
            raise FireVoiceError("bad_request", f"dictionary: {e}")
        try:
            base = get_style(req.style or "conversational")
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))
        if not 0.25 <= float(req.pace) <= 4.0:
            raise FireVoiceError("bad_request", "pace must be between 0.25 and 4.0")
        if req.candidates < 1 or req.candidates > 8:
            raise FireVoiceError("bad_request", "candidates must be between 1 and 8")
        if req.lufs is not None and not -40 <= float(req.lufs) <= -6:
            raise FireVoiceError("bad_request", "lufs must be between -40 and -6 (or null for raw audio)")
        bad = set(req.style_overrides) - STYLE_FIELDS
        if bad:
            raise FireVoiceError("bad_request", f"unknown style field(s): {', '.join(sorted(bad))}; valid: {', '.join(sorted(STYLE_FIELDS))}")
        # voice
        v = req.voice or "default"
        if v.startswith("design:"):
            if not (inf.design or inf.presets):
                raise FireVoiceError("bad_request", f"engine {eng} cannot speak from a description; design-capable engines: "
                                                    f"{', '.join(n for n, e in catalog.CATALOG.items() if e.design and n != 'null')}")
        else:
            if v != "default" and not self.voices.exists(v):
                raise FireVoiceError("not_found", f"unknown voice {v!r}")
            if v == "default" and self.voices.default_id() is None and inf.needs_reference:
                raise FireVoiceError("bad_request", "no default voice set; pass a voice id or set one with `firevoice voices default NAME`")
            if not inf.clone and v != "default":
                raise FireVoiceError("bad_request", f"engine {eng} cannot clone a voice; use voice 'design:<description>'" +
                                     (f" or a preset ({', '.join(inf.presets[:5])}...)" if inf.presets else ""))
        # params
        try:
            params, pw = catalog.validate_params(eng, req.params)
        except ValueError as e:
            raise FireVoiceError("bad_request", str(e))
        warn += pw
        if req.language and inf.languages and "*" not in inf.languages and req.language.split("-")[0] not in inf.languages:
            warn.append(f"engine {eng} does not list language {req.language!r} ({', '.join(inf.languages)})")
        fields = dict(req.style_overrides)
        if req.instruct is not None:
            fields["instruct"] = req.instruct
            if req.instruct and not inf.instruct:
                warn.append(f"engine {eng} ignores delivery instructions")
        extra = {**base.extra, **params}
        if req.instruct and "ultimate" not in params and inf.param("ultimate") is not None:
            # an explicit instruction only works in clip-only cloning; style presets' own instructions do not switch it
            extra["ultimate"] = False
        if req.language and "language" not in params and inf.param("language") is not None:
            extra["language"] = _language_param(inf, req.language)
        style = dataclasses.replace(base, extra=extra, **fields)
        return eng, style, params, warn

    def tts(self, req: TTSRequest, on_chunk: Optional[Callable[[dict], None]] = None, cancel: Optional[threading.Event] = None,
            priority: int = 0) -> Render:
        """Render `req`. `cancel` (an Event) stops it within a fraction of a second and drops its queued generations;
        `priority` 1 marks background work that yields the GPU to interactive renders."""
        eng, style, _params, warn = self.prepare(req)
        ld = self._pool(eng, hold=True)
        t0 = time.perf_counter()
        try:
            s = self._synth(ld, req.validate, req.candidates, req.accept)
            res = s.speak(req.text, voice=req.voice or "default", custom_style=style, pace=req.pace, seed=req.seed,
                          lufs=req.lufs, lead_ms=req.lead_ms, tail_ms=req.tail_ms, lang=req.language, on_chunk=on_chunk, cancel=cancel,
                          priority=priority, rules=self._rules(req), keep_takes=req.keep_takes)
        except Cancelled:
            raise
        except FireVoiceError:
            raise
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))
        except ValueError as e:
            raise FireVoiceError("bad_request", str(e))
        except Exception as e:
            raise FireVoiceError("internal", f"{type(e).__name__}: {str(e)[:400]}")
        finally:
            with self._lock:
                ld.active -= 1
                ld.last_used = time.time()
        r = Render(res, req, eng, time.perf_counter() - t0, warn)
        if req.keep_takes and res.chunks:
            r.render_id = self.renders.save(res, req.to_dict(), eng, lufs=req.lufs, lead_ms=req.lead_ms, tail_ms=req.tail_ms)
        return r

    def _rules(self, req: "TTSRequest") -> list:
        from .dictionary import parse_rules
        try:
            return self.dictionary.compiled(parse_rules(req.dictionary))
        except ValueError as e:
            raise FireVoiceError("bad_request", f"dictionary: {e}")

    # -------------------------------------------------------------------- dictionary
    def dictionary_view(self) -> dict:
        try:
            rules = self.dictionary.rules()
        except ValueError as e:
            raise FireVoiceError("internal", str(e))
        return {"rules": rules, "builtin": self.dictionary.builtin()}

    def dictionary_add(self, rule: dict) -> dict:
        try:
            return self.dictionary.add(rule)
        except ValueError as e:
            raise FireVoiceError("bad_request", str(e))

    def dictionary_update(self, rule_id: str, fields: dict) -> dict:
        try:
            return self.dictionary.update(rule_id, fields)
        except KeyError:
            raise FireVoiceError("not_found", f"no dictionary rule {rule_id!r}")
        except ValueError as e:
            raise FireVoiceError("bad_request", str(e))

    def dictionary_remove(self, rule_id: str) -> dict:
        try:
            self.dictionary.remove(rule_id)
        except KeyError:
            raise FireVoiceError("not_found", f"no dictionary rule {rule_id!r}")
        return {"id": rule_id, "removed": True}

    def dictionary_replace(self, rules: list) -> dict:
        try:
            return {"rules": self.dictionary.replace(rules)}
        except ValueError as e:
            raise FireVoiceError("bad_request", str(e))

    def dictionary_test(self, text: str, engine: Optional[str] = None, language: Optional[str] = None, dictionary=None) -> dict:
        """What the engine will actually read for `text`, after your rules and the built-in text pass."""
        from .dictionary import parse_rules
        from .frontend.normalize import normalize
        eng = self._resolve_engine(engine)
        spell = _adapter_attr(eng, "spell_acronyms", True)
        try:
            rules = self.dictionary.compiled(parse_rules(dictionary))
        except ValueError as e:
            raise FireVoiceError("bad_request", f"dictionary: {e}")
        spoken = normalize(text, self.lexicon, language, spell_acronyms=spell, rules=rules)
        return {"text": text, "spoken": spoken, "engine": eng}

    # -------------------------------------------------------------------- kept renders (takes)
    def render_list(self, limit: int = 50) -> list[dict]:
        return self.renders.list(limit)

    def render_get(self, rid: str) -> dict:
        try:
            return self.renders.view(rid)
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))

    def render_audio(self, rid: str) -> tuple:
        try:
            return self.renders.stitch(rid)
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))

    def render_take_path(self, rid: str, index: int, n: int) -> Path:
        try:
            return self.renders.take_path(rid, index, n)
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))

    def render_retake(self, rid: str, index: int, seed: Optional[int] = None, choose: bool = True,
                      cancel: Optional[threading.Event] = None) -> dict:
        """A new take of one passage of a kept render, made like the original (same voice, style, pace, checks)."""
        import random
        meta = self.render_get(rid)
        ch = next((c for c in meta["chunks"] if c["index"] == index), None)
        if ch is None:
            raise FireVoiceError("not_found", f"render {rid} has no passage {index}")
        req = TTSRequest.from_dict({k: v for k, v in meta["request"].items() if k in {f.name for f in dataclasses.fields(TTSRequest)}})
        eng, style, _params, _warn = self.prepare(req)
        if ch["style"] != "request":
            try:
                style = dataclasses.replace(get_style(ch["style"]), extra={**get_style(ch["style"]).extra, **style.extra})
            except KeyError:
                pass
        ld = self._pool(eng, hold=True)
        try:
            s = self._synth(ld, req.validate, 1, req.accept)
            take = s.retake(ch["text"], voice=req.voice or "default", style=style, pace=ch["pace"],
                            seed=int(seed if seed is not None else random.randint(1, 2**31 - 1)),
                            cuts=[tuple(c) for c in ch.get("cuts") or []], asr=ch.get("asr", True), cancel=cancel)
        except Cancelled:
            raise
        except FireVoiceError:
            raise
        except Exception as e:
            raise FireVoiceError("internal", f"{type(e).__name__}: {str(e)[:400]}")
        finally:
            with self._lock:
                ld.active -= 1
                ld.last_used = time.time()
        self.renders.add_take(rid, index, take, choose=choose)
        return self.render_get(rid)

    def render_choose(self, rid: str, index: int, n: int) -> dict:
        try:
            self.renders.choose(rid, index, n)
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))
        return self.render_get(rid)

    def render_lock(self, rid: str, index: int, locked: bool) -> dict:
        try:
            self.renders.lock(rid, index, locked)
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))
        return self.render_get(rid)

    def render_regenerate(self, rid: str, indexes: Optional[list[int]] = None, cancel: Optional[threading.Event] = None) -> dict:
        """New takes for the given passages, or for every unlocked one."""
        meta = self.render_get(rid)
        todo = indexes if indexes else [c["index"] for c in meta["chunks"] if not c.get("locked")]
        locked = {c["index"] for c in meta["chunks"] if c.get("locked")}
        for i in todo:
            if cancel is not None and cancel.is_set():
                raise Cancelled("cancelled")
            if i in locked:
                continue
            self.render_retake(rid, i, cancel=cancel)
        return self.render_get(rid)

    def render_delete(self, rid: str) -> dict:
        self.render_get(rid)
        self.renders.delete(rid)
        return {"id": rid, "deleted": True}

    def subtitles(self, words, fmt: str = "srt") -> tuple[str, str]:
        from . import subtitles as S
        try:
            return S.render(words, fmt)
        except ValueError as e:
            raise FireVoiceError("bad_request", str(e))

    def stream(self, req: TTSRequest, cancel: Optional[threading.Event] = None) -> Iterator[dict]:
        """Yield chunks in order while later ones are still rendering (all chunks render in parallel). Each item:
        {"type": "chunk", index, total, start, sample_rate, audio (float32 array), words, text} and finally
        {"type": "done", **render info} or {"type": "error", code, message}."""
        import queue
        q: "queue.Queue[dict]" = queue.Queue()
        cancel = cancel or threading.Event()

        def run():
            try:
                r = self.tts(req, on_chunk=lambda c: q.put({"type": "chunk", **c}), cancel=cancel)
                info = r.info()
                info.pop("words", None)
                q.put({"type": "done", **info})
            except Cancelled:
                q.put({"type": "cancelled"})
            except FireVoiceError as e:
                q.put({"type": "error", "code": e.code, "message": e.message})
            except Exception as e:
                q.put({"type": "error", "code": "internal", "message": f"{type(e).__name__}: {e}"})

        th = threading.Thread(target=run, daemon=True, name="fv-stream")
        th.start()
        try:
            while True:
                item = q.get()
                if item["type"] == "chunk":
                    item["sample_rate"] = item.pop("sr")
                    item["words"] = [w.__dict__ for w in item["words"]]
                yield item
                if item["type"] in ("done", "error", "cancelled"):
                    return
        finally:
            cancel.set()   # consumer went away: stop rendering at the next chunk boundary

    @staticmethod
    def encode(render: Render | np.ndarray, fmt: str = "wav", sample_rate: Optional[int] = None, sr: Optional[int] = None, bitrate: str = "192k") -> bytes:
        if isinstance(render, Render):
            audio, sr = render.audio, render.sr
        else:
            audio = render
        try:
            return A.encode_bytes(audio, int(sr), fmt, bitrate=bitrate, out_sr=sample_rate)
        except ValueError as e:
            raise FireVoiceError("bad_request", str(e))

    # -------------------------------------------------------------------- stt
    def transcribe(self, audio: np.ndarray | str | Path, sr: Optional[int] = None, language: Optional[str] = None, beam_size: int = 5) -> dict:
        import soundfile as sf
        if isinstance(audio, (str, Path)):
            try:
                audio, sr = sf.read(str(audio), dtype="float32", always_2d=False)
            except Exception as e:
                raise FireVoiceError("bad_request", f"cannot read audio: {e}")
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if not sr or len(audio) < int(sr) // 10:
            raise FireVoiceError("bad_request", "audio is empty or too short")
        asr = self._stt_model()
        t0 = time.perf_counter()
        lang = None if not language or language == "auto" else language
        try:
            r = asr.transcribe_full(audio, int(sr), beam_size=beam_size, language=lang)
        except Exception as e:
            raise FireVoiceError("internal", f"transcription failed: {e}")
        return {"text": r["text"], "language": r["language"], "language_probability": r["language_probability"],
                "duration": round(len(audio) / sr, 3), "seconds": round(time.perf_counter() - t0, 3), "model": asr.model_name, "device": asr.device,
                "words": [w.__dict__ for w in r["words"]]}

    def _stt_model(self):
        """STT shares the validation Whisper model (one GPU copy)."""
        return self.aligner()

    # -------------------------------------------------------------------- voices
    def voice_list(self, language: Optional[str] = None, gender: Optional[str] = None, tag: Optional[str] = None, q: Optional[str] = None,
                   kind: Optional[str] = None) -> list[dict]:
        out = []
        default = self.voices.default_id()
        for v in self.voices.list():
            lang = v.get("language") or "en"
            if language and lang != language:
                continue
            if gender and v.get("gender") != gender:
                continue
            if tag and tag not in v.get("tags", []):
                continue
            k = "designed" if ("designed" in v.get("tags", []) or v.get("category") == "designed") else "cloned"
            if kind and kind != k:
                continue
            if q and q.lower() not in " ".join(str(x) for x in (v["voice_id"], v.get("name"), v.get("description"), v.get("accent"), v.get("source"))).lower():
                continue
            v["has_preview"] = (self.voices.root / v["voice_id"] / "preview.mp3").exists()
            out.append(_voice_view(v, default))
        return out

    def voice(self, voice_id: str) -> dict:
        voice_id = self.voices.canonical(voice_id)
        try:
            m = self.voices.get(voice_id)
        except KeyError:
            raise FireVoiceError("not_found", f"unknown voice {voice_id!r}")
        d = _voice_view({**m, "has_ref": bool(self.voices.ref_path(voice_id)), "styles": self.voices.list_styles(voice_id),
                         "has_preview": (Path(m["dir"]) / "preview.mp3").exists()}, self.voices.default_id())
        d["transcript"] = self.voices.ref_text(voice_id)
        return d

    def voice_preview_path(self, voice_id: str, style: Optional[str] = None) -> Path:
        self.voice(voice_id)
        p = self.voices.ref_path(voice_id, style)
        if not p:
            raise FireVoiceError("not_found", f"voice {voice_id!r} has no reference clip" + (f" for style {style!r}" if style else ""))
        return Path(p)

    def voice_add(self, name: str, audio_path: str | Path, *, consent: bool, description: str = "", gender: str = "", language: str = "",
                  accent: str = "", tags: Optional[list] = None, transcript: Optional[str] = None, source: str = "", license: str = "") -> dict:
        if not consent:
            raise FireVoiceError("bad_request", "consent is required: only add voices you own or have permission to use")
        if self.voices.exists(name):
            raise FireVoiceError("conflict", f"voice {name!r} already exists")
        try:
            meta = self.voices.add(name, audio_path, consent=True, description=description, gender=gender, tags=tags, source=source or "uploaded",
                                   license=license, transcript=transcript or None, transcribe=not transcript,
                                   extra={"language": language or None, "accent": accent or None})
        except (ValueError, PermissionError) as e:
            raise FireVoiceError("bad_request", str(e))
        return self.voice(meta["voice_id"])

    def voice_update(self, voice_id: str, **fields) -> dict:
        allowed = {"name", "description", "gender", "tags", "language", "accent", "license", "source", "favorite", "notes", "tagline", "traits", "use_cases"}
        bad = set(fields) - allowed
        if bad:
            raise FireVoiceError("bad_request", f"cannot update {', '.join(sorted(bad))}; editable: {', '.join(sorted(allowed))}")
        voice_id = self.voice(voice_id)["voice_id"]
        if fields.get("name"):
            clash = [v["voice_id"] for v in self.voices.list() if str(v.get("name", "")).lower() == fields["name"].lower() and v["voice_id"] != voice_id]
            if clash:
                raise FireVoiceError("conflict", f"the name {fields['name']!r} is already used by {clash[0]}")
            fields["branded_by"] = "user"
        self.voices.update(voice_id, **{k: v for k, v in fields.items() if v is not None})
        return self.voice(voice_id)

    def voice_set_transcript(self, voice_id: str, transcript: str) -> dict:
        self.voice(voice_id)
        if not (transcript or "").strip():
            raise FireVoiceError("bad_request", "the transcript is empty; it must be the exact words spoken in the reference clip")
        (Path(self.voices.get(voice_id)["dir"]) / "ref.txt").write_text(transcript.strip(), encoding="utf-8")
        self._forget_voice(voice_id)
        return self.voice(voice_id)

    def voice_remove(self, voice_id: str) -> dict:
        self.voice(voice_id)
        self.voices.remove(voice_id)
        self._forget_voice(voice_id)
        return {"voice_id": voice_id, "removed": True}

    def voice_set_default(self, voice_id: str) -> dict:
        self.voice(voice_id)
        self.voices.set_default(voice_id)
        return self.voice(voice_id)

    def voice_add_style_ref(self, voice_id: str, style: str, audio_path: str | Path, transcript: Optional[str] = None) -> dict:
        self.voice(voice_id)
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,40}", style or ""):
            raise FireVoiceError("bad_request", f"invalid style name {style!r}")
        try:
            get_style(style)
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))
        try:
            self.voices.add_style_ref(voice_id, style, audio_path, transcript=transcript, transcribe=not transcript)
        except ValueError as e:
            raise FireVoiceError("bad_request", str(e))
        self._forget_voice(voice_id)
        return self.voice(voice_id)

    def voice_design(self, name: str, description: str, *, engine: Optional[str] = None, text: Optional[str] = None, gender: str = "",
                     language: str = "", seed: int = 1234, tags: Optional[list] = None) -> dict:
        """Invent a voice from a description with a design-capable engine, then lock that take as the voice's
        reference clip so every later line (and every engine) keeps exactly this identity."""
        if not description.strip():
            raise FireVoiceError("bad_request", "a description is required")
        if self.voices.exists(name):
            raise FireVoiceError("conflict", f"voice {name!r} already exists")
        eng = self._resolve_engine(engine or ("voxcpm2" if catalog.info("voxcpm2").status()["ready"] else None))
        if not catalog.info(eng).design:
            raise FireVoiceError("bad_request", f"engine {eng} cannot design voices")
        line = text or DESIGN_TEXT
        r = self.tts(TTSRequest(text=line, engine=eng, voice="design:" + description, style="neutral", instruct="", seed=seed, lufs=-20.0,
                                lead_ms=0, tail_ms=0, validate=False))
        tmp = home() / f"_design_{os.getpid()}_{threading.get_ident()}.wav"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        A.write_audio(tmp, r.audio, r.sr)
        try:
            self.voices.add(name, tmp, consent=True, description=description, gender=gender, tags=["designed", f"designed:{eng}", *(tags or [])],
                            source=f"designed with {eng}", license="synthetic", transcript=line, transcribe=False,
                            extra={"language": language or None, "design_prompt": description})
        finally:
            tmp.unlink(missing_ok=True)
        return self.voice(name)

    def voice_collections(self) -> list[dict]:
        from .branding import collections
        return collections(self.voice_list())

    def voice_preview_clip(self, voice_id: str) -> Path:
        """The branded preview ("Hi, I'm Isla...") when rendered, otherwise the original reference clip."""
        v = self.voice(voice_id)
        p = self.voices.root / v["voice_id"] / "preview.mp3"
        return p if p.exists() else self.voice_preview_path(v["voice_id"])

    def voice_render_preview(self, voice_id: str, engine: Optional[str] = None, seed: int = 1234, priority: int = 0) -> dict:
        from .branding import preview_text
        v = self.voice(voice_id)
        text, lang = preview_text(v)
        r = self.tts(TTSRequest(text=text, engine=engine, voice=v["voice_id"], style="conversational", instruct="", language=lang, seed=seed,
                                validate=lang == "en"), priority=priority)
        _atomic_write(self.voices.root / v["voice_id"] / "preview.mp3", self.encode(r, "mp3"))
        return {**self.voice(v["voice_id"]), "preview_text": text, "preview_seconds": round(r.duration, 2)}

    def voice_brand(self, report: Optional[str] = None, force: bool = False, log=None, only: Optional[list[str]] = None,
                    names: Optional[dict[str, str]] = None) -> list[dict]:
        """Names, taglines, traits, use cases and quality tiers for every voice. `report` is a listening-test report.json
        (default: $FIREVOICE_REPORT, else samples/voxcpm2/judge/report.json next to the code when present). `only` limits
        it to some voices and keeps every other name; `names` pins names."""
        from .branding import brand, load_report
        report = report or os.environ.get("FIREVOICE_REPORT") or str(Path(__file__).resolve().parents[2] / "samples" / "voxcpm2" / "judge" / "report.json")
        for k in list(only or []) + list(names or {}):
            if not self.voices.exists(k):
                raise FireVoiceError("not_found", f"no voice {k!r}")
        return brand(self.voices, load_report(report), force=force, only=only, names=names, log=log or (lambda *_: None))

    def _forget_voice(self, voice_id: str) -> None:
        """Cached conditioning in running workers would keep the old clip; drop it so the next request re-prepares."""
        with self._lock:
            for ld in self._loaded.values():
                for w in getattr(ld.pool, "workers", []):
                    try:
                        w.voices.discard(voice_id)
                        w.voices = {v for v in w.voices if not str(v).startswith(voice_id + ":")}
                    except Exception:
                        pass

    # -------------------------------------------------------------------- styles
    def style_list(self) -> list[dict]:
        user = _user_style_dir()
        return [{**style_dict(s), "builtin": not (user / f"{n}.json").exists()} for n, s in sorted(all_styles(refresh=True).items())]

    def style(self, name: str) -> dict:
        try:
            s = get_style(name)
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))
        return {**style_dict(s), "builtin": not (_user_style_dir() / f"{s.name}.json").exists()}

    def style_save(self, data: dict) -> dict:
        import json
        import re
        name = str(data.get("name", "")).strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,40}", name):
            raise FireVoiceError("bad_request", "style name must be 1-41 characters: letters, digits, - or _")
        bad = set(data) - STYLE_FIELDS - {"name", "extra"}
        if bad:
            raise FireVoiceError("bad_request", f"unknown style field(s): {', '.join(sorted(bad))}")
        try:
            raw = {**data, "name": name}
            for k in ("emo_vector", "tags"):
                if k in raw:
                    raw[k] = tuple(raw[k])
            Style(**raw)
        except TypeError as e:
            raise FireVoiceError("bad_request", str(e))
        d = _user_style_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{name}.json").write_text(json.dumps({**data, "name": name}, indent=1, ensure_ascii=False), encoding="utf-8")
        all_styles(refresh=True)
        return self.style(name)

    def style_remove(self, name: str) -> dict:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,40}", name or ""):
            raise FireVoiceError("bad_request", f"invalid style name {name!r}: lowercase letters, digits, - and _ only")
        f = _user_style_dir() / f"{name}.json"
        if not f.exists():
            raise FireVoiceError("bad_request" if name in all_styles() else "not_found",
                                 f"style {name!r} is built in and cannot be deleted" if name in all_styles() else f"unknown style {name!r}")
        f.unlink()
        all_styles(refresh=True)
        return {"name": name, "removed": True}

    # -------------------------------------------------------------------- system
    def system(self) -> dict:
        from . import __version__
        from .core.gpu import gpu_info
        gpu = gpu_info()
        return {"version": __version__, "uptime_seconds": round(time.time() - self.started, 1), "home": str(home()), "voices_dir": str(self.voices.root),
                "default_engine": self._resolve_engine(None), "loaded_engines": sorted(self._loaded), "gpu": gpu,
                "asr": {"model": self.asr_model, "loaded": self._aligner is not None},
                "jobs": self.jobs.counts(), "voices": len(self.voices.list()), "styles": len(all_styles())}

    def close(self) -> None:
        self.jobs.close()
        with self._lock:
            lds = list(self._loaded.values())
            self._loaded.clear()
        for ld in lds:
            self._stop(ld)


DESIGN_TEXT = ("Hello there, and welcome; today I want to walk you through something I genuinely love, one small step at a time, "
               "so get comfortable, grab something warm to drink, and let's begin together.")


def _voice_view(v: dict, default: Optional[str]) -> dict:
    keep = ("voice_id", "name", "tagline", "traits", "use_cases", "quality", "featured", "category", "description", "gender",
            "language", "accent", "age", "tags", "source", "license", "ref_seconds", "created", "has_ref", "has_preview", "styles", "design_prompt",
            "favorite", "notes")
    d = {k: v.get(k) for k in keep if k in v}
    d.setdefault("language", "en")
    d["kind"] = "designed" if ("designed" in (v.get("tags") or []) or v.get("category") == "designed") else "cloned"
    d["default"] = v["voice_id"] == default
    return d


def _language_param(inf, code: str):
    """Map an ISO code onto an engine's language parameter (Qwen wants English names)."""
    p = inf.param("language")
    names = {"zh": "Chinese", "en": "English", "ja": "Japanese", "ko": "Korean", "de": "German", "fr": "French", "ru": "Russian",
             "pt": "Portuguese", "es": "Spanish", "it": "Italian", "ar": "Arabic", "hi": "Hindi", "ur": "Urdu", "tr": "Turkish"}
    if p is not None and p.type == "enum":
        n = names.get(code.split("-")[0])
        return n if n in (p.choices or []) else p.default
    if p is not None and p.name == "language" and inf.name == "dots":
        return code.split("-")[0]
    return names.get(code.split("-")[0], code)


def _user_style_dir() -> Path:
    return home() / "styles"


def _free_vram_gb() -> Optional[float]:
    from .core.gpu import free_vram_gb
    return free_vram_gb()


def _free_cuda_cache() -> None:
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _null_aligner():
    from .asr import NullAligner
    return NullAligner()


def _atomic_write(path: Path, data: bytes) -> None:
    """Write via a temp file and rename, so a crash never leaves a half-written file behind."""
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _adapter_attr(engine: str, name: str, default):
    """A class attribute of an engine's adapter, read without loading the model (adapters import their heavy
    libraries only when they load)."""
    import importlib
    from .core.adapters import ADAPTERS
    try:
        mod, cls = ADAPTERS[engine].split(":")
        return getattr(getattr(importlib.import_module(mod), cls), name, default)
    except Exception:
        return default
