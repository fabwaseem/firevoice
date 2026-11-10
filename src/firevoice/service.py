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
import json
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

from .paths import home  # noqa: E402  (re-exported: other modules import home from here)


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
    watermark: Optional[bool] = None        # inaudible "made by FireVoice" mark; None = the server's policy (default: on)

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
                 "lufs": float, "candidates": int, "accept": float, "validate": bool, "lead_ms": int, "tail_ms": int, "keep_takes": bool, "watermark": bool,
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
    watermarked: bool = False

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
                "warnings": self.warnings + list(self.result.warnings), "render_id": self.render_id, "watermarked": self.watermarked,
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
        from .projects import ProjectStore
        self.projects = ProjectStore(home() / "projects")
        self.jobs = JobManager(self)

    # -------------------------------------------------------------------- engines
    def engine_names(self, task: str = "tts") -> list[str]:
        """Engines for one task: "tts" (default), "sfx" (sound effects and music), "vc" (the voice changer) or "all"."""
        names = [n for n in all_engines() if task == "all" or _task(n) == task]
        return [n for n in names if n != "null"] if os.environ.get("FIREVOICE_HIDE_NULL", "1") == "1" else names

    def engines(self, task: str = "tts") -> list[dict]:
        return [{**self.engine(n), "task": _task(n)} for n in self.engine_names(task)]

    # -------------------------------------------------------------------- sound effects and music
    def sound(self, prompt: str, kind: str = "sfx", duration: float = 5.0, seed: Optional[int] = None, *, engine: Optional[str] = None,
              params: Optional[dict] = None, priority: int = 0, cancel: Optional[threading.Event] = None) -> tuple:
        """A sound effect, ambience (kind "sfx", AudioLDM 2, up to 30 s) or music (kind "music", MusicGen, up to 180 s:
        past 30 s it is continued pass by pass) from a description. -> (audio, sample rate, info)"""
        import random
        from concurrent.futures import TimeoutError as FutTimeout
        prompt = re.sub(r"\s+", " ", str(prompt or "")).strip()
        if not prompt:
            raise FireVoiceError("bad_request", "describe the sound")
        if kind not in ("sfx", "music"):
            raise FireVoiceError("bad_request", "kind must be 'sfx' (effects, ambience) or 'music'")
        eng = self._resolve_engine(engine) if engine else ("musicgen" if kind == "music" else "audioldm2")
        if _task(eng) != "sfx":
            raise FireVoiceError("bad_request", f"{eng} does not make sound effects or music")
        if not catalog.info(eng).status()["ready"]:
            raise FireVoiceError("unavailable", f"{eng} is not installed: install it from Engines (POST /api/v1/engines/{eng}/install)")
        seed = int(seed if seed is not None else random.randint(1, 2**31 - 1))
        dp = catalog.info(eng).param("duration")
        top = float(dp.max) if dp is not None and dp.max else 30.0
        p = {**(params or {}), "duration": float(max(1.0, min(top, duration)))}
        ld = self._pool(eng, hold=True)
        group = threading.Event()
        t0 = time.perf_counter()
        try:
            fut = ld.pool.submit(prompt, None, p, seed, priority=priority, group=group)
            while True:
                try:
                    out = fut.result(timeout=0.25)
                    break
                except FutTimeout:
                    if cancel is not None and cancel.is_set():
                        group.set()
                        raise Cancelled("cancelled")
        except (Cancelled, FireVoiceError):
            raise
        except Exception as e:
            raise FireVoiceError("internal", f"{eng} failed: {str(e)[:300]}")
        finally:
            group.set()
            with self._lock:
                ld.active -= 1
                ld.last_used = time.time()
        sr = ld.pool.sr or catalog.info(eng).sample_rate
        a = np.asarray(out, dtype=np.float32)
        a = a - float(a.mean()) if len(a) else a
        peak = float(np.abs(a).max()) if len(a) else 0.0
        if peak > 0:
            a = a / peak * 0.89                      # -1 dBFS
        a = A.fade(a, sr)
        if self._mark_wanted(None, None):
            a = self._mark(a, sr, "sound")
        return a, sr, {"engine": eng, "kind": kind, "seed": seed, "duration": round(len(a) / sr, 2), "seconds": round(time.perf_counter() - t0, 2),
                       "prompt": prompt, "license": catalog.info(eng).to_dict().get("license") or get_engine(eng).license}

    @staticmethod
    def _installable(name: str) -> bool:
        from .installer import MANIFESTS
        m = MANIFESTS.get(name)
        return bool(m and m.auto)

    def engine(self, name: str) -> dict:
        try:
            spec = get_engine(name)
        except ValueError as e:
            raise FireVoiceError("not_found", str(e))
        inf = catalog.info(spec.name)
        loaded = self._loaded.get(spec.name)
        from .core import brands
        br = brands.describe(spec.name, spec.vram_gb)
        d = {**inf.to_dict(), "model": inf.title, **br, "title": br["brand"] or inf.title,
             "speed_rtf": (br["tier"] or {}).get("rtf") or inf.speed_rtf,
             "name": spec.name, "license": spec.license, "commercial": spec.commercial, "vram_gb": spec.vram_gb,
             "default_workers": spec.default_workers, "description": spec.description, **inf.status(), "default": spec.name == self._resolve_engine(None),
             "loaded": loaded is not None, "installable": self._installable(spec.name)}
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

    def engine_install_plan(self, name: str, sizes: bool = True) -> dict:
        """What installing an engine would do and download, and what is already there."""
        from . import installer
        try:
            return installer.plan(name, sizes=sizes)
        except (KeyError, ValueError) as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))

    def engine_uninstall(self, name: str, weights: bool = False) -> dict:
        """Remove an engine's venv (and its weights when asked). Unloads every engine that shares the venv first."""
        from . import installer
        try:
            m = installer.manifest(name)
        except (KeyError, ValueError) as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))
        if m.venv is None:
            raise FireVoiceError("bad_request", f"{m.engine} runs inside the backend's own environment")
        for e, x in installer.MANIFESTS.items():
            if x.venv == m.venv and e in self._loaded:
                self.unload(e)
        try:
            return installer.uninstall(m.engine, weights=weights)
        except OSError as e:
            raise FireVoiceError("conflict", f"could not remove every file (is something still using it?): {e}")

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
        mark = self._mark_wanted(req.watermark, warn)
        if mark and on_chunk is not None:
            user_cb = on_chunk

            def on_chunk(c, _cb=user_cb):
                if c.get("audio") is not None and len(c["audio"]):
                    c = {**c, "audio": self._mark(c["audio"], c["sr"])}
                _cb(c)
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
        if mark:
            res.audio = self._mark(res.audio, res.sr)
        r = Render(res, req, eng, time.perf_counter() - t0, warn, watermarked=mark)
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
        """The stitched chosen takes (marked like any render, unless the render asked not to be)."""
        try:
            a, sr, words = self.renders.stitch(rid)
            flag = (self.renders.get(rid).get("request") or {}).get("watermark")
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))
        if self._mark_wanted(flag, None):
            a = self._mark(a, sr)
        return a, sr, words

    # -------------------------------------------------------------------- watermark
    def _mark_wanted(self, flag: Optional[bool], warn: Optional[list]) -> bool:
        from . import watermark
        if not watermark.wanted(flag):
            return False
        if not watermark.available():
            if warn is not None and flag:
                warn.append("not watermarked: the backend has no audioseal (pip install firevoice[watermark])")
            return False
        return True

    def _mark(self, audio: np.ndarray, sr: int, kind: str = "render") -> np.ndarray:
        from . import watermark
        try:
            return watermark.embed(audio, sr, kind)
        except Exception as e:  # a failed mark must never cost the user their render
            import logging
            logging.getLogger("firevoice").warning("watermark failed: %s", e)
            return audio

    def audio_detect(self, path) -> dict:
        """Is there an AI-audio watermark in this file, and is it FireVoice's?"""
        from . import watermark
        if not watermark.available():
            raise FireVoiceError("unavailable", "the watermark detector needs the audioseal package (pip install firevoice[watermark])")
        a, sr = self._read(path)
        return watermark.detect(a, sr)

    # -------------------------------------------------------------------- Urdu check
    URDU_LINES = ["Assalam o alaikum, aap kaise hain?", "Aaj mausam bohat acha hai, chalo bahar chalte hain.",
                  "Mujhe yeh kitaab bohat pasand aayi.", "Kal subah das baje meeting hai, waqt par aana.",
                  "Hum ne pichle saal Lahore ka safar kiya tha.", "Shukriya, aap ki madad se kaam jaldi ho gaya."]

    def urdu_check(self, engine: Optional[str] = None, voices: Optional[list] = None, asr_model: Optional[str] = None,
                   on_item: Optional[Callable[[dict], None]] = None) -> dict:
        """How well Whisper hears Urdu speech: Roman Urdu lines rendered with Urdu voices, transcribed in Urdu, compared
        as consonant skeletons. Tells whether the Urdu take check can be trusted, and with which Whisper model."""
        from . import urdu
        from .asr import FasterWhisperAligner
        picks = voices or [v["voice_id"] for v in self.voice_list(language="ur")][:3]
        if not picks:
            raise FireVoiceError("not_found", "no Urdu voices in the library (language ur)")
        asr = self._stt_model() if not asr_model else FasterWhisperAligner(model=asr_model, language="ur")
        items = []
        for vid in picks:
            for line in self.URDU_LINES:
                r = self.tts(TTSRequest(text=line, voice=vid, engine=engine, language="ur", validate=False, watermark=False))
                heard = asr.transcribe(r.audio, r.sr, language="ur")
                script = " ".join(w.text for w in heard)
                it = {"voice": vid, "text": line, "heard": urdu.to_roman(script), "match": urdu.match(line, script)}
                items.append(it)
                if on_item:
                    on_item(it)
        scores = [i["match"] for i in items]
        mean = round(float(np.mean(scores)), 3)
        ok = sum(1 for x in scores if x >= 0.8) / len(scores)
        verdict = ("reliable: the Urdu take check can be trusted" if ok >= 0.9 else
                   "mixed: the Urdu check will flag some good takes; review flagged takes by ear" if ok >= 0.6 else
                   "unreliable: Whisper does not hear this engine's Urdu well; keep the Urdu check off or try another model")
        return {"engine": self._resolve_engine(engine), "asr_model": getattr(asr, "model_name", "?"), "mean": mean, "min": round(min(scores), 3),
                "pass_rate": round(ok, 3), "verdict": verdict, "items": items}

    # -------------------------------------------------------------------- dubbing
    def dub(self, path, target: str, *, source: Optional[str] = None, voice: Optional[str] = None, cast: Optional[dict] = None,
            keep_voices: bool = False, consent: bool = False, diarize: bool = False, speakers: Optional[int] = None,
            engine: Optional[str] = None, style: str = "conversational", background: float = 0.0, lufs: Optional[float] = -16.0,
            translator: Optional[str] = None, keep_music: bool = False, progress: Optional[Callable[[str, int, int, str], None]] = None,
            cancel: Optional[threading.Event] = None, priority: int = 1) -> dict:
        """A recording's speech in another language on the original timeline: transcribe (with speakers when there is
        a cast or the original voices are kept), translate locally, render each line, fit it to its slot, mix.
        `keep_voices` clones each original speaker for the dub (temporary voices, removed afterwards) and needs
        `consent`. `background` (0-1) keeps that much of the original audio underneath.
        -> {audio, sr, lines: [{start, end, text, translation, speaker, voice, speed, at, duration}], source_language, target_language}"""
        import uuid

        import soundfile as sf

        from . import dubbing
        from . import translate as T
        say = progress or (lambda *_a: None)
        tgt = (target or "").lower().split("-")[0]
        if not T.supported(tgt):
            raise FireVoiceError("bad_request", f"cannot dub into {target!r}; languages: {', '.join(T.LANGS)}")
        if keep_voices and not consent:
            raise FireVoiceError("bad_request", "keeping the original voices clones the speakers: confirm consent (only for recordings you have the rights to)")
        if not 0.0 <= float(background) <= 1.0:
            raise FireVoiceError("bad_request", "background must be between 0 and 1")
        a, sr = self._read(path)
        total = len(a) / sr
        say("transcribe", 0, 1, "listening to the original")
        tr = self.transcribe(a, sr, language=source or "auto", diarize=bool(diarize or keep_voices or cast), speakers=speakers)
        src = tr["language"]
        if not T.supported(src):
            raise FireVoiceError("bad_request", f"cannot translate from {src!r}")
        lines = dubbing.units(tr["segments"])
        if not lines:
            raise FireVoiceError("bad_request", "no speech found in the recording")
        say("translate", 0, len(lines), f"translating {len(lines)} lines from {src} to {tgt}")
        try:
            texts = T.translate([ln["text"] for ln in lines], src, tgt, progress=lambda k, n: say("translate", k, n, f"translated {k} of {n}"),
                                model=translator)
        except ImportError as e:
            raise FireVoiceError("unavailable", f"translation needs {e.name or 'transformers'} and sentencepiece")
        cast = dict(cast or {})
        temp: list[str] = []
        try:
            if keep_voices:
                for spk in sorted({ln.get("speaker") or "Speaker 1" for ln in lines}):
                    parts, have = [], 0.0
                    for ln in lines:
                        if (ln.get("speaker") or "Speaker 1") == spk and have < 15.0:
                            seg = a[int(ln["start"] * sr):int(ln["end"] * sr)]
                            parts.append(seg)
                            have += len(seg) / sr
                    if have < 3.0:
                        continue
                    import tempfile
                    fd, wav = tempfile.mkstemp(suffix=".wav")
                    os.close(fd)
                    sf.write(wav, np.concatenate(parts), sr, subtype="PCM_16")
                    vid = f"dub-{uuid.uuid4().hex[:8]}-{re.sub(r'[^a-z0-9]+', '-', spk.lower()).strip('-')}"
                    try:
                        self.voices.add(vid, wav, consent=True, transcribe=False, source="dubbing (temporary clone of the original speaker)",
                                        description=f"{spk} from a dubbed recording")
                    finally:
                        Path(wav).unlink(missing_ok=True)
                    temp.append(vid)
                    cast.setdefault(spk, vid)
            pieces, out_sr, rows = [], None, []
            for i, ln in enumerate(lines):
                if cancel is not None and cancel.is_set():
                    raise Cancelled("cancelled")
                say("render", i, len(lines), f"line {i + 1} of {len(lines)}")
                v = dubbing.voice_for(ln.get("speaker"), cast, voice or "default")
                # lines are marked once as a whole below: fitting a line to its slot stretches time, which erases a mark
                r = self.tts(TTSRequest(text=texts[i] or "...", voice=v, engine=engine, style=style, language=tgt, lead_ms=0, tail_ms=0,
                                        lufs=None, watermark=False), cancel=cancel, priority=priority)
                out_sr = out_sr or r.sr
                aud = r.audio if r.sr == out_sr else A.resample(r.audio, r.sr, out_sr)
                aud, speed = dubbing.fit(aud, out_sr, dubbing.slot(lines, i, total))
                pieces.append((ln["start"], aud))
                rows.append({**ln, "translation": texts[i], "voice": v, "speed": speed, "duration": round(len(aud) / out_sr, 3)})
            track, placed = dubbing.assemble(pieces, out_sr, total)
            for row, at in zip(rows, placed):
                row["at"] = at
            if keep_music:
                # the original's music and effects, without its voices, under the dub at their own level
                say("render", len(lines), len(lines), "keeping the music and effects")
                _v, rest, rsr = self.audio_separate(path, "vocals", priority=priority, cancel=cancel)
                bed = A.resample(rest, rsr, out_sr)
                n = min(len(bed), len(track))
                track[:n] += bed[:n]
            elif background > 0:
                bed = A.resample(np.asarray(a, dtype=np.float32), sr, out_sr) * float(background)
                n = min(len(bed), len(track))
                track[:n] += bed[:n]
            if lufs is not None and len(track) > out_sr // 10:
                track = A.studio_chain(track, out_sr, lufs)
            if self._mark_wanted(None, None):
                track = self._mark(track, out_sr)
            say("render", len(lines), len(lines), "mixed")
            return {"audio": track.astype(np.float32), "sr": out_sr, "lines": rows, "source_language": src, "target_language": tgt,
                    "voices_kept": bool(temp), "translator": T.resolve(translator)}
        finally:
            for vid in temp:
                try:
                    self.voices.remove(vid)
                except Exception:
                    pass

    # -------------------------------------------------------------------- quality reports
    def _voice_clip(self, voice: Optional[str], strict: bool = True) -> tuple:
        """(audio, sample rate) of a voice's reference clip, or (None, None) for voices without one. `strict` raises for
        an unknown voice; otherwise it too gives (None, None)."""
        import soundfile as sf
        if not voice or str(voice).startswith("design:"):
            return None, None
        try:
            v = self.voice(voice)
            p = Path(self.voices.get(v["voice_id"])["dir"]) / "ref.wav"
        except FireVoiceError:
            if strict:
                raise
            return None, None
        except Exception:
            return None, None
        if not p.exists():
            return None, None
        a, sr = sf.read(str(p), dtype="float32", always_2d=False)
        return (a.mean(axis=1) if a.ndim > 1 else a), int(sr)

    def quality_report(self, path, voice: Optional[str] = None) -> dict:
        """Speaker similarity to `voice` (WavLM), DNSMOS scores and a drift check of any audio file."""
        from . import quality
        a, sr = self._read(path)
        ref, rsr = self._voice_clip(voice)
        try:
            r = quality.report(a, sr, ref, rsr)
        except ImportError as e:
            raise FireVoiceError("unavailable", f"quality checks need {e.name or 'an optional package'} (pip install firevoice[desktop])")
        return {**r, "voice": self.voices.canonical(voice) if voice and ref is not None else None}

    def render_quality(self, rid: str) -> dict:
        """The quality report of a kept render's stitched audio against the voice it was rendered with."""
        from . import quality
        a, sr, _w = self.render_audio(rid)
        voice = (self.renders.get(rid).get("request") or {}).get("voice") or "default"
        ref, rsr = self._voice_clip(voice, strict=False)
        try:
            r = quality.report(a, sr, ref, rsr)
        except ImportError as e:
            raise FireVoiceError("unavailable", f"quality checks need {e.name or 'an optional package'}")
        return {**r, "voice": voice if ref is not None else None, "render_id": rid}

    def watermark_status(self) -> dict:
        from . import watermark
        return {"policy": watermark.policy(), "available": watermark.available()}

    def render_take_path(self, rid: str, index: int, n: int) -> Path:
        try:
            return self.renders.take_path(rid, index, n)
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))

    def render_retake(self, rid: str, index: int, seed: Optional[int] = None, choose: bool = True,
                      cancel: Optional[threading.Event] = None) -> dict:
        """A new take of one passage of a kept render, made like the original (same voice, style, pace, checks)."""
        meta = self.render_get(rid)
        ch = next((c for c in meta["chunks"] if c["index"] == index), None)
        if ch is None:
            raise FireVoiceError("not_found", f"render {rid} has no passage {index}")
        take = self._passage_take(meta, ch, ch["text"], seed, cancel)
        self.renders.add_take(rid, index, take, choose=choose)
        return self.render_get(rid)

    def render_edit(self, rid: str, index: int, text: str, mode: str = "splice", seed: Optional[int] = None,
                    cancel: Optional[threading.Event] = None) -> dict:
        """Change the words of one passage of a kept render. "splice" re-records the passage with the new text and
        keeps the original audio around the change (only the edited words are new); "passage" uses the whole new
        recording. Splicing falls back to the whole passage when most of it changed. The result is a new take, chosen."""
        import soundfile as sf

        from . import wordedit
        from .types import Word
        if mode not in ("splice", "passage"):
            raise FireVoiceError("bad_request", "mode must be 'splice' (keep the audio around the edit) or 'passage'")
        text = re.sub(r"\s+", " ", str(text or "")).strip()
        if not text:
            raise FireVoiceError("bad_request", "the new text is empty")
        meta = self.render_get(rid)
        ch = next((c for c in meta["chunks"] if c["index"] == index), None)
        if ch is None:
            raise FireVoiceError("not_found", f"render {rid} has no passage {index}")
        if ch.get("locked"):
            raise FireVoiceError("conflict", f"passage {index} is locked; unlock it to edit it")
        if text == ch["text"]:
            raise FireVoiceError("bad_request", "the text did not change")
        same_shape = len(text.split()) == len(ch["text"].split())
        take = self._passage_take(meta, {**ch, "cuts": ch.get("cuts") if same_shape else []}, text, seed, cancel)
        info = {"mode": "passage", "from_take": ch["chosen"], "old_text": ch["text"]}
        if mode == "splice":
            old = next((t for t in ch["takes"] if t["n"] == ch["chosen"]), None)
            if old is not None and old.get("words"):
                a, _sr = sf.read(str(self.renders.take_path(rid, index, old["n"])), dtype="float32", always_2d=False)
                sp = wordedit.splice(a, old["words"], np.asarray(take["audio"], dtype=np.float32), take["words"], meta["sample_rate"])
                if sp is not None:
                    take = {**take, "audio": sp["audio"], "words": [Word(w["text"], w["start"], w["end"]) for w in sp["words"]],
                            "said": " ".join(w["text"] for w in sp["words"])}
                    info.update(mode="splice", changed_words=sp["changed"], cuts_s=sp["cuts_s"])
                else:
                    info["note"] = "most of the passage changed (or its words could not be lined up), so the whole new take is used"
        self.renders.add_take(rid, index, take, choose=True, text=text, edit=info)
        return self.render_get(rid)

    def _passage_take(self, meta: dict, ch: dict, text: str, seed: Optional[int], cancel: Optional[threading.Event]) -> dict:
        """Generate, check and finish one passage of a kept render like the original (voice, style, pace, cuts)."""
        import random
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
            return s.retake(text, voice=req.voice or "default", style=style, pace=ch["pace"],
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

    # -------------------------------------------------------------------- projects
    def _project(self, pid: str) -> dict:
        try:
            return self.projects.get(pid)
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))

    def _check_defaults(self, defaults: Optional[dict]) -> None:
        from .projects import LAYOUT_FIELDS
        if defaults is None:
            return
        if not isinstance(defaults, dict):
            raise FireVoiceError("bad_request", "defaults must be an object")
        tts = {k: v for k, v in defaults.items() if k not in LAYOUT_FIELDS}
        for k in ("text", "keep_takes"):
            tts.pop(k, None)
        self.prepare(TTSRequest.from_dict({**tts, "text": "check"}))
        for k in LAYOUT_FIELDS:
            v = defaults.get(k)
            if v is not None and (not isinstance(v, (int, float)) or isinstance(v, bool) or not 0 <= v <= 30000):
                raise FireVoiceError("bad_request", f"{k} must be a number of milliseconds between 0 and 30000")

    def project_list(self) -> list[dict]:
        from .projects import summary
        return [summary(p) for p in self.projects.list()]

    def project_get(self, pid: str) -> dict:
        from .projects import view
        return view(self._project(pid))

    def project_create(self, title: str, text: str = "", defaults: Optional[dict] = None) -> dict:
        from .projects import view
        self._check_defaults(defaults)
        return view(self.projects.create(title, text, defaults))

    def project_update(self, pid: str, title: Optional[str] = None, defaults: Optional[dict] = None, chapters: Optional[list] = None) -> dict:
        from .projects import view
        self._project(pid)
        self._check_defaults(defaults)
        try:
            p, dropped = self.projects.update(pid, title=title, defaults=defaults, chapters=chapters)
        except ValueError as e:
            raise FireVoiceError("bad_request", str(e))
        for rid in dropped:          # paragraphs that were deleted take their renders with them
            self.renders.delete(rid)
        return view(p)

    def project_delete(self, pid: str) -> dict:
        p = self._project(pid)
        for ch in p["chapters"]:
            for para in ch["paragraphs"]:
                if para.get("render"):
                    self.renders.delete(para["render"]["id"])
        self.projects.delete(pid)
        return {"id": pid, "deleted": True}

    def paragraph_render(self, pid: str, para_id: str, priority: int = 0, cancel: Optional[threading.Event] = None) -> dict:
        """Render one paragraph with its current text and settings (every take kept). Its old render is replaced."""
        from .projects import find_para, render_key, request_for, view
        p = self._project(pid)
        try:
            para = find_para(p, para_id)
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))
        if not para["text"].strip():
            raise FireVoiceError("bad_request", "this paragraph is empty")
        req = request_for(p, para)
        r = self.tts(TTSRequest.from_dict(req), cancel=cancel, priority=priority)
        if not r.render_id:
            raise FireVoiceError("internal", "the render was not kept")
        self.renders.pin(r.render_id, pid)
        p, old = self.projects.set_render(pid, para_id, {"id": r.render_id, "key": render_key(req), "duration": round(r.duration, 3), "at": time.time()})
        if old and old != r.render_id:
            self.renders.delete(old)
        return view(p)

    def paragraph_lock(self, pid: str, para_id: str, locked: bool) -> dict:
        from .projects import view
        self._project(pid)
        try:
            return view(self.projects.set_lock(pid, para_id, locked))
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))

    def paragraph_audio(self, pid: str, para_id: str) -> tuple:
        from .projects import find_para
        p = self._project(pid)
        try:
            para = find_para(p, para_id)
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))
        if not para.get("render"):
            raise FireVoiceError("not_found", "this paragraph has not been rendered yet")
        return self.render_audio(para["render"]["id"])

    def project_todo(self, pid: str, scope: str = "stale", chapter: Optional[str] = None) -> list[tuple[str, str]]:
        """(chapter id, paragraph id) to render: "stale" = drafts and stale ones, "all" = everything not locked."""
        from .projects import status
        p = self._project(pid)
        out = []
        for ch in p["chapters"]:
            if chapter and ch["id"] != chapter:
                continue
            for para in ch["paragraphs"]:
                st = status(p, para)
                if not para["text"].strip() or st == "locked":
                    continue
                if scope == "all" or st in ("draft", "stale"):
                    out.append((ch["id"], para["id"]))
        return out

    def project_audio(self, pid: str, chapter: Optional[str] = None, master: Optional[str] = None, allow_missing: bool = False) -> tuple:
        """The project (or one chapter) as one timeline of the paragraphs' chosen takes.
        -> (audio, sample rate, words with absolute times, [(chapter title, start s, end s)])"""
        from .projects import audiobook_check, master_audiobook, status  # noqa: F401
        p = self._project(pid)
        lay = p.get("defaults") or {}
        chapters = [c for c in p["chapters"] if not chapter or c["id"] == chapter]
        if chapter and not chapters:
            raise FireVoiceError("not_found", f"project {pid} has no chapter {chapter!r}")
        missing = [para for c in chapters for para in c["paragraphs"] if para["text"].strip() and not para.get("render")]
        if missing and not allow_missing:
            raise FireVoiceError("conflict", f"{len(missing)} paragraph(s) are not rendered yet; render them first (or export with allow_missing)")
        pieces = []
        for c in chapters:
            for para in c["paragraphs"]:
                if para.get("render"):
                    a, sr, w = self.render_audio(para["render"]["id"])
                    pieces.append((c, para, a, sr, w))
        if not pieces:
            raise FireVoiceError("conflict", "nothing is rendered yet")
        sr = max(x[3] for x in pieces)
        parts, words, marks = [], [], []
        t = 0.0
        cur_ch = None
        for c, para, a, psr, w in pieces:
            if c is not cur_ch:
                if cur_ch is not None:
                    gap = A.silence(int(lay.get("chapter_gap_ms", 2500)), sr)
                    parts.append(gap)
                    t += len(gap) / sr
                    marks[-1] = (marks[-1][0], marks[-1][1], t)
                lead = A.silence(int(lay.get("chapter_lead_ms", 500)), sr)
                marks.append((c["title"], t, t))
                parts.append(lead)
                t += len(lead) / sr
                cur_ch = c
            elif parts:
                gap = A.silence(int(lay.get("paragraph_gap_ms", 700)), sr)
                parts.append(gap)
                t += len(gap) / sr
            a = A.resample(a, psr, sr)
            words += [{"text": x["text"], "start": round(t + x["start"], 3), "end": round(t + x["end"], 3)} for x in w]
            parts.append(a)
            t += len(a) / sr
        tail = A.silence(1500, sr)
        parts.append(tail)
        t += len(tail) / sr
        marks[-1] = (marks[-1][0], marks[-1][1], t)
        out = np.concatenate(parts).astype(np.float32)
        if master == "audiobook":
            out = master_audiobook(out, sr)
        return out, sr, words, marks

    def project_export(self, pid: str, fmt: str = "mp3", chapter: Optional[str] = None, master: Optional[str] = None,
                       allow_missing: bool = False) -> tuple[bytes, str, str]:
        """-> (bytes, media type, file name). fmt: any audio format, or m4b (chapter marks), srt, vtt."""
        import re as _re
        from .projects import m4b_bytes
        p = self._project(pid)
        a, sr, words, marks = self.project_audio(pid, chapter, master, allow_missing)
        stem = _re.sub(r"[^\w\- ]+", "", p["title"]).strip()[:60] or pid
        if chapter:
            stem += " - " + _re.sub(r"[^\w\- ]+", "", marks[0][0]).strip()[:40]
        if fmt in ("srt", "vtt"):
            text, mt = self.subtitles(words, fmt)
            return text.encode("utf-8"), mt, f"{stem}.{fmt}"
        if fmt == "m4b":
            return m4b_bytes(a, sr, marks, p["title"]), "audio/mp4", f"{stem}.m4b"
        if fmt not in A.FORMATS:
            raise FireVoiceError("bad_request", f"unknown format {fmt!r}; use m4b, srt, vtt or {', '.join(A.FORMATS)}")
        return self.encode(a, fmt, sr=sr), A.media_type(fmt), f"{stem}.{A.FORMATS[fmt][2]}"

    def project_check(self, pid: str, master: Optional[str] = None) -> dict:
        """The audiobook check for every chapter (rendered paragraphs only)."""
        from .projects import audiobook_check
        p = self._project(pid)
        out = []
        for c in p["chapters"]:
            if not any(para.get("render") for para in c["paragraphs"]):
                out.append({"chapter": c["id"], "title": c["title"], "pass": False, "checks": [], "note": "nothing rendered yet"})
                continue
            a, sr, _w, _m = self.project_audio(pid, c["id"], master, allow_missing=True)
            out.append({"chapter": c["id"], "title": c["title"], **audiobook_check(a, sr)})
        return {"master": master, "chapters": out, "pass": bool(out) and all(c["pass"] for c in out)}

    def project_bundle(self, pid: str) -> tuple[bytes, str]:
        from .bundles import project_bundle
        p = self._project(pid)
        stem = re.sub(r"[^\w\- ]+", "", p["title"]).strip()[:60] or pid
        return project_bundle(p, self.renders.root), f"{stem}.fvproject.zip"

    def project_import(self, data: bytes) -> dict:
        from .bundles import import_project_bundle
        from .projects import view
        try:
            return view(import_project_bundle(data, self.projects.root, self.renders.root))
        except (ValueError, KeyError) as e:
            raise FireVoiceError("bad_request", str(e))
        except Exception as e:
            raise FireVoiceError("bad_request", f"cannot read the bundle: {e}")

    def voice_pack(self, voice_id: str) -> tuple[bytes, str]:
        from .bundles import voice_pack
        v = self.voice(voice_id)
        return voice_pack(Path(self.voices.get(v["voice_id"])["dir"])), f"{v['voice_id']}.fvvoice.zip"

    def voice_import(self, data: bytes, *, consent: bool, voice_id: Optional[str] = None) -> dict:
        """Add a voice from a voice pack. Like any cloned voice it needs consent: only import voices you own or have
        permission to use."""
        import io
        import json as _json
        import zipfile
        from .bundles import import_voice_pack
        from .voices import _slug
        if not consent:
            raise FireVoiceError("bad_request", "consent is required: only import voices you own or have permission to use")
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                meta = _json.loads(z.read("meta.json").decode("utf-8"))
        except Exception as e:
            raise FireVoiceError("bad_request", f"not a FireVoice voice pack: {e}")
        vid = _slug(voice_id or meta.get("voice_id") or "voice")
        base, k = vid, 2
        while self.voices.exists(vid):
            vid = f"{base}-{k}"
            k += 1
        try:
            import_voice_pack(data, self.voices.root, vid)
        except (ValueError, FileExistsError) as e:
            raise FireVoiceError("bad_request", str(e))
        prior = self.voices.get(vid).get("consent_record")
        self.voices.update(vid, consent=True, imported=time.time(),
                           consent_record=self._consent_record(vid, None, "import", extra={"original": prior} if prior else None))
        name = (self.voices.get(vid).get("name") or "")
        if name and any(str(v.get("name", "")).lower() == name.lower() and v["voice_id"] != vid for v in self.voices.list()):
            self.voices.update(vid, name=f"{name} ({vid})")
        return self.voice(vid)

    # -------------------------------------------------------------------- dialogue
    def dialogue_parse(self, script: str, cast: Optional[dict] = None) -> dict:
        """The turns, the speakers, and a cast with a voice for every speaker (yours where given)."""
        from .dialogue import auto_cast, parse, speakers
        turns = parse(script)
        if not any(not t.get("kind") for t in turns):
            raise FireVoiceError("bad_request", "the script has no lines")
        if sum(1 for t in turns if t.get("kind") == "music") > 1:
            raise FireVoiceError("bad_request", "one [music: ...] bed per script")
        names = speakers(turns)
        return {"turns": turns, "speakers": names, "cast": auto_cast(names, self.voice_list(), cast)}

    def dialogue(self, script: str, *, cast: Optional[dict] = None, defaults: Optional[dict] = None, gap_ms: int = 350,
                 lufs: Optional[float] = -16.0, seed: int = 1234, priority: int = 0, cancel: Optional[threading.Event] = None,
                 on_turn: Optional[Callable[[int, int], None]] = None) -> dict:
        """Render a dialogue: every turn in its speaker's voice (and style), in order, with a short gap between
        speakers. -> {audio, sr, stems: {speaker: audio on the same timeline}, turns: [{speaker, voice, text, start,
        end}], words: [{text, start, end, speaker}], cast}"""
        from concurrent.futures import ThreadPoolExecutor
        info = self.dialogue_parse(script, cast)
        turns, cast = info["turns"], info["cast"]
        base = {k: v for k, v in (defaults or {}).items() if k not in ("text", "voice", "keep_takes")}
        speech = [i for i, t in enumerate(turns) if not t.get("kind")]
        cues = [i for i, t in enumerate(turns) if t.get("kind")]
        for i in cues:   # sound cues need their engine; say so before rendering any speech
            eng = "musicgen" if turns[i]["kind"] == "music" else "audioldm2"
            if not catalog.info(eng).status()["ready"]:
                raise FireVoiceError("unavailable", f"the script has a [{turns[i]['kind']}: ...] cue but {eng} is not installed (Engines)")
        reqs = []
        for i in speech:
            t = turns[i]
            c = cast[t["speaker"]]
            d = {**base, "text": t["text"], "voice": c.get("voice") or "default", "seed": seed + i * 101, "lufs": None, "lead_ms": 0, "tail_ms": 0}
            for k in ("style", "pace", "engine", "instruct", "language"):
                if c.get(k) not in (None, ""):
                    d[k] = c[k]
            req = TTSRequest.from_dict(d)
            self.prepare(req)                      # fail before rendering anything
            reqs.append(req)
        done = {"n": 0}

        total_steps = len(reqs) + len(cues)

        def one(k):
            if cancel is not None and cancel.is_set():
                raise Cancelled("cancelled")
            r = self.tts(reqs[k], cancel=cancel, priority=priority)
            done["n"] += 1
            if on_turn:
                on_turn(done["n"], total_steps)
            return r
        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="fv-dialogue") as ex:
            renders_by = dict(zip(speech, ex.map(one, range(len(reqs)))))
        sr = max(r.sr for r in renders_by.values())
        sounds = {}
        for i in cues:
            t = turns[i]
            if t["kind"] == "music" and not t.get("seconds"):
                # a bed as long as the speech (up to 2 minutes), so it seldom has to loop
                speech_s = sum(r.duration for r in renders_by.values()) + gap_ms / 1000 * len(turns)
                secs = float(min(120.0, max(30.0, speech_s + 1.0)))
            else:
                secs = t.get("seconds") or (30.0 if t["kind"] == "music" else 3.0)
            a_, s_, _info = self.sound(t["text"], t["kind"], secs, seed + i * 101, priority=priority, cancel=cancel)
            sounds[i] = A.resample(a_, s_, sr)
            done["n"] += 1
            if on_turn:
                on_turn(done["n"], total_steps)
        names = info["speakers"] + (["SFX"] if any(turns[i]["kind"] == "sfx" for i in cues) else [])
        mix, stems = [], {n: [] for n in names}
        out_turns, words = [], []
        t = 0.15
        lead = A.silence(150, sr)
        mix.append(lead)
        for n in names:
            stems[n].append(lead)
        placed = 0
        for i, turn in enumerate(turns):
            if turn.get("kind") == "music":
                continue
            r = renders_by.get(i)
            a = A.resample(r.audio, r.sr, sr) if r is not None else sounds[i] * 0.7
            if placed:
                g = A.silence(int(gap_ms), sr)
                mix.append(g)
                for n in names:
                    stems[n].append(g)
                t += len(g) / sr
            start = t
            mix.append(a)
            for n in names:
                stems[n].append(a if n == turn["speaker"] else np.zeros(len(a), np.float32))
            if r is not None:
                factor = len(a) / max(1, len(r.audio))
                words += [{"text": w.text, "start": round(t + w.start * factor, 3), "end": round(t + w.end * factor, 3), "speaker": turn["speaker"]}
                          for w in r.result.words]
            t += len(a) / sr
            placed += 1
            out_turns.append({"speaker": turn["speaker"], "voice": cast[turn["speaker"]].get("voice") if r is not None else None,
                              "text": turn["text"] if r is not None else f"[sfx: {turn['text']}]", "start": round(start, 3), "end": round(t, 3),
                              **({"kind": "sfx"} if r is None else {})})
        tail = A.silence(400, sr)
        mix.append(tail)
        for n in names:
            stems[n].append(tail)
        audio = np.concatenate(mix).astype(np.float32)
        out_stems = {n: np.concatenate(v).astype(np.float32) for n, v in stems.items()}
        music = next((i for i in cues if turns[i]["kind"] == "music"), None)
        if music is not None:
            bed = _loop_to(sounds[music], len(audio), sr) * 0.16          # about -16 dB under the voices
            fade_in, fade_out = min(len(bed), int(1.0 * sr)), min(len(bed), int(2.5 * sr))
            bed[:fade_in] *= np.linspace(0, 1, fade_in, dtype=np.float32)
            bed[len(bed) - fade_out:] *= np.linspace(1, 0, fade_out, dtype=np.float32)
            audio = audio + bed
            out_stems["Music"] = bed
            out_turns.insert(0, {"speaker": "Music", "voice": None, "text": f"[music: {turns[music]['text']}]", "start": 0.0,
                                 "end": round(len(audio) / sr, 3), "kind": "music"})
        if lufs is not None and len(audio) > sr // 10:
            audio = A.studio_chain(audio, sr, lufs)
        return {"audio": audio, "sr": sr, "stems": out_stems, "turns": out_turns, "words": words, "cast": cast}

    def dialogue_subtitles(self, turns: list[dict], fmt: str = "srt") -> str:
        """One cue per turn (split when long), labelled with the speaker."""
        from . import subtitles as S
        cues = []
        for t in turns:
            if t.get("kind"):          # sound cues are heard, not spoken
                continue
            cues.append({"start": t["start"], "end": t["end"], "text": f"{t['speaker']}: {t['text']}"})
        if fmt == "vtt":
            return "WEBVTT\n\n" + "\n".join(f"{S._ts(c['start'], '.')} --> {S._ts(c['end'], '.')}\n{S._wrap(c['text'])}\n" for c in cues)
        return "\n".join(f"{i}\n{S._ts(c['start'], ',')} --> {S._ts(c['end'], ',')}\n{S._wrap(c['text'])}\n" for i, c in enumerate(cues, 1))

    # -------------------------------------------------------------------- OpenAI-compatible names
    OPENAI_VOICES = {"alloy": ("female", 0), "ash": ("male", 0), "ballad": ("male", 1), "coral": ("female", 1), "echo": ("male", 2),
                     "fable": ("male", 3), "nova": ("female", 2), "onyx": ("male", 4), "sage": ("female", 3), "shimmer": ("female", 4),
                     "verse": ("male", 5)}

    def openai_voice(self, name: str) -> str:
        """An OpenAI voice name ("alloy", "nova"...) as a library voice: a library voice of that name or id first, then
        FIREVOICE_HOME/openai_voices.json ({"alloy": "Isla"}), then a fixed pick among the best English voices."""
        if name and self.voices.exists(name):
            return self.voices.canonical(name)
        f = home() / "openai_voices.json"
        if f.exists():
            try:
                m = json.loads(f.read_text(encoding="utf-8"))
                if name in m and self.voices.exists(m[name]):
                    return self.voices.canonical(m[name])
            except Exception:
                pass
        gender, k = self.OPENAI_VOICES.get((name or "").lower(), ("female", 0))
        ranked = sorted((v for v in self.voice_list() if v.get("gender") == gender and v.get("language", "en") == "en" and v.get("kind") == "cloned"),
                        key=lambda v: ((v.get("quality") or {}).get("rank") or 999, v["voice_id"]))
        return ranked[k % len(ranked)]["voice_id"] if ranked else "default"

    def tag_catalog(self) -> dict:
        """Sound tags (engines with tag support read them; others drop them) and delivery tags (a style switch)."""
        from .frontend.markup import DELIVERY_TAGS
        sound = ["laugh", "chuckle", "giggle", "sigh", "gasp", "cough", "clear throat", "sniff", "groan", "hmm"]
        engines = [e["name"] for e in self.engines() if e.get("tags")]
        return {"sound": [{"tag": f"[{t}]", "engines": engines} for t in sound],
                "delivery": [{"tag": f"[{k}]", "style": v} for k, v in DELIVERY_TAGS.items()] + [{"tag": "[normal]", "style": None}],
                "markup": ["[pause 500ms]", "[pause 2s]", "[style NAME]", "[pace 0.9]"]}

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
    def transcribe(self, audio: np.ndarray | str | Path, sr: Optional[int] = None, language: Optional[str] = None, beam_size: int = 5,
                   prompt: Optional[str] = None, keyterms: Optional[list] = None, diarize: bool = False, speakers: Optional[int] = None) -> dict:
        """Speech to text with word times and segments. `keyterms` (names, jargon) and `prompt` steer spellings;
        `diarize` labels who speaks when (Speaker 1, Speaker 2...; `speakers` fixes how many)."""
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
        hot = ", ".join(str(k).strip() for k in (keyterms or []) if str(k).strip())[:800] or None
        try:
            r = asr.transcribe_full(audio, int(sr), beam_size=beam_size, language=lang, prompt=prompt, hotwords=hot)
        except Exception as e:
            raise FireVoiceError("internal", f"transcription failed: {e}")
        words = [w.__dict__ for w in r["words"]]
        segments = r.get("segments") or []
        if diarize and segments:
            from .diarize import label_speakers
            labels = label_speakers(audio, int(sr), segments, speakers)
            for seg, lab in zip(segments, labels):
                seg["speaker"] = lab
                for i in seg["words"]:
                    words[i]["speaker"] = lab
        for seg in segments:
            seg.pop("words", None)
        roman = {}
        if r["language"] == "ur":       # Urdu script, also in English letters (Roman Urdu) for reading along
            from .urdu import to_roman
            for w in words:
                w["roman"] = to_roman(w["text"])
            for seg in segments:
                seg["roman"] = to_roman(seg["text"])
            roman = {"text_roman": to_roman(r["text"])}
        return {**roman, "text": r["text"], "language": r["language"], "language_probability": r["language_probability"],
                "duration": round(len(audio) / sr, 3), "seconds": round(time.perf_counter() - t0, 3), "model": asr.model_name, "device": asr.device,
                "words": words, "segments": segments}

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
            v["avatar"] = _avatar_version(self.voices.root / v["voice_id"])
            out.append(_voice_view(v, default))
        return out

    def voice(self, voice_id: str) -> dict:
        voice_id = self.voices.canonical(voice_id)
        try:
            m = self.voices.get(voice_id)
        except KeyError:
            raise FireVoiceError("not_found", f"unknown voice {voice_id!r}")
        d = _voice_view({**m, "has_ref": bool(self.voices.ref_path(voice_id)), "styles": self.voices.list_styles(voice_id),
                         "has_preview": (Path(m["dir"]) / "preview.mp3").exists(), "avatar": _avatar_version(Path(m["dir"]))}, self.voices.default_id())
        d["transcript"] = self.voices.ref_text(voice_id)
        return d

    def voice_preview_path(self, voice_id: str, style: Optional[str] = None) -> Path:
        self.voice(voice_id)
        p = self.voices.ref_path(voice_id, style)
        if not p:
            raise FireVoiceError("not_found", f"voice {voice_id!r} has no reference clip" + (f" for style {style!r}" if style else ""))
        return Path(p)

    def voice_add(self, name: str, audio_path: str | Path, *, consent: bool, description: str = "", gender: str = "", language: str = "",
                  accent: str = "", tags: Optional[list] = None, transcript: Optional[str] = None, source: str = "", license: str = "",
                  clean: Optional[str] = None, consent_by: Optional[str] = None, via: str = "api") -> dict:
        """Add a cloned voice. `clean` ("light", "medium", "strong") cleans the clip first. The result carries the clip's
        quality check (`quality_check`) so a client can warn about noise, clipping or length."""
        if not consent:
            raise FireVoiceError("bad_request", "consent is required: only add voices you own or have permission to use")
        if self.voices.exists(name):
            raise FireVoiceError("conflict", f"voice {name!r} already exists")
        import soundfile as sf
        from .cleanup import analyze
        from .cleanup import clean as clean_audio
        try:
            a, sr = sf.read(str(audio_path), dtype="float32", always_2d=False)
        except Exception as e:
            raise FireVoiceError("bad_request", f"cannot read the clip: {e}")
        a = a.mean(axis=1) if a.ndim > 1 else a
        before = analyze(a, sr)
        if clean:
            try:
                a = clean_audio(a, sr, clean)
            except ValueError as e:
                raise FireVoiceError("bad_request", str(e))
            import tempfile
            fd, tmp = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            sf.write(tmp, a, sr, subtype="PCM_16")
            audio_path = tmp
        try:
            meta = self.voices.add(name, audio_path, consent=True, description=description, gender=gender, tags=tags, source=source or "uploaded",
                                   license=license, transcript=transcript or None, transcribe=not transcript,
                                   extra={"language": language or None, "accent": accent or None})
        except (ValueError, PermissionError) as e:
            raise FireVoiceError("bad_request", str(e))
        check = {"before": before, "after": analyze(a, sr) if clean else None, "cleaned": clean or None}
        self.voices.update(meta["voice_id"], quality_check=check,
                           consent_record=self._consent_record(meta["voice_id"], consent_by, via, original_clip=str(audio_path)))
        return {**self.voice(meta["voice_id"]), "quality_check": check}

    # -------------------------------------------------------------------- consent records
    CONSENT_STATEMENT = ("The person adding this voice confirmed that they are the speaker, or have the speaker's permission "
                         "to clone this voice and generate speech with it.")

    def _consent_record(self, vid: str, by: Optional[str], via: str, original_clip: Optional[str] = None, extra: Optional[dict] = None) -> dict:
        """What was agreed, by whom, when, through what, and fingerprints of the clip it covers (the upload as received,
        and the reference as stored), so a later change to the clip is visible."""
        import datetime
        import hashlib

        def sha(p) -> Optional[str]:
            try:
                return hashlib.sha256(Path(p).read_bytes()).hexdigest()
            except OSError:
                return None
        ref = self.voices.root / vid / "ref.wav"
        rec = {"given": True, "by": (by or "").strip()[:120] or None, "via": via, "statement": self.CONSENT_STATEMENT,
               "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
               "upload_sha256": sha(original_clip) if original_clip else None, "ref_sha256": sha(ref)}
        return {**rec, **(extra or {})}

    def voice_consent(self, voice_id: str) -> dict:
        """The voice's consent record, or what its permission rests on when it has none (a dataset licence, a design)."""
        import hashlib
        v = self.voice(voice_id)
        meta = self.voices.get(v["voice_id"])
        rec = meta.get("consent_record")
        ref = self.voices.root / v["voice_id"] / "ref.wav"
        now = hashlib.sha256(ref.read_bytes()).hexdigest() if ref.exists() else None
        if rec:
            return {"voice_id": v["voice_id"], "basis": "consent", **rec,
                    "clip_unchanged": (rec.get("ref_sha256") == now) if rec.get("ref_sha256") and now else None,
                    "clip_note": None if not rec.get("ref_sha256") or rec.get("ref_sha256") == now
                    else "the reference clip changed after consent was recorded (cleaned or replaced)"}
        lic, src = meta.get("license") or "", meta.get("source") or ""
        if lic == "synthetic" or meta.get("category") == "designed" or src.startswith("designed"):
            basis = "synthetic: a designed voice, not a recording of a real person"
        elif lic:
            basis = f"dataset licence {lic}: recorded by contributors who released their voices for this use"
        else:
            basis = "unknown: added before consent records were kept"
        return {"voice_id": v["voice_id"], "basis": basis, "given": None, "source": src or None, "license": lic or None,
                "added": meta.get("created")}

    # -------------------------------------------------------------------- audio tools: check, clean, voice changer
    @staticmethod
    def _read(path) -> tuple:
        import soundfile as sf
        try:
            a, sr = sf.read(str(path), dtype="float32", always_2d=False)
        except Exception as e:
            raise FireVoiceError("bad_request", f"cannot read the audio: {e}")
        return (a.mean(axis=1) if a.ndim > 1 else a), int(sr)

    def audio_analyze(self, path) -> dict:
        from .cleanup import analyze
        a, sr = self._read(path)
        return analyze(a, sr)

    def audio_clean(self, path, strength: str = "medium") -> tuple:
        """-> (cleaned audio, sample rate, {before, after}). strength "neural" uses the separator engine's speech
        denoiser (a RoFormer network) and then levels and trims like the others."""
        from .cleanup import analyze, clean
        a, sr = self._read(path)
        if strength == "neural":
            voice, _rest, vsr = self.audio_separate(path, "denoise")
            out = clean(voice, vsr, "light")
            return out, vsr, {"before": analyze(a, sr), "after": analyze(out, vsr)}
        try:
            out = clean(a, sr, strength)
        except ValueError as e:
            raise FireVoiceError("bad_request", str(e))
        return out, sr, {"before": analyze(a, sr), "after": analyze(out, sr)}

    def audio_separate(self, path, mode: str = "vocals", priority: int = 0, cancel: Optional[threading.Event] = None) -> tuple:
        """Split a recording with the separator engine. mode: vocals (voice | music and effects), denoise (voice | noise),
        dereverb (voice | room echo). -> (voice, the rest, sample rate)"""
        import tempfile
        from concurrent.futures import TimeoutError as FutTimeout

        import soundfile as sf
        if mode not in ("vocals", "denoise", "dereverb"):
            raise FireVoiceError("bad_request", "mode must be vocals, denoise or dereverb")
        if not catalog.info("separator").status()["ready"]:
            raise FireVoiceError("unavailable", "the voice separator is not installed: install it from Engines (POST /api/v1/engines/separator/install)")
        fd, other = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        ld = self._pool("separator", hold=True)
        group = threading.Event()
        try:
            fut = ld.pool.submit("", None, {"source": str(Path(path).resolve()), "mode": mode, "other_out": other}, 0, priority=priority, group=group)
            while True:
                try:
                    voice = fut.result(timeout=0.25)
                    break
                except FutTimeout:
                    if cancel is not None and cancel.is_set():
                        group.set()
                        raise Cancelled("cancelled")
            sr = ld.pool.sr or 44100
            try:
                rest, rsr = sf.read(other, dtype="float32", always_2d=False)
                rest = rest.mean(axis=1) if rest.ndim > 1 else rest
                rest = A.resample(rest, int(rsr), sr) if int(rsr) != sr else rest
            except Exception:
                rest = np.zeros(0, np.float32)
        except (Cancelled, FireVoiceError):
            raise
        except Exception as e:
            raise FireVoiceError("internal", f"separation failed: {str(e)[:300]}")
        finally:
            group.set()
            Path(other).unlink(missing_ok=True)
            with self._lock:
                ld.active -= 1
                ld.last_used = time.time()
        return np.asarray(voice, dtype=np.float32), np.asarray(rest, dtype=np.float32), int(sr)

    def voice_clean(self, voice_id: str, strength: str = "medium") -> dict:
        """Clean a library voice's reference clip in place (the original is kept as ref.original.wav)."""
        import shutil
        import soundfile as sf
        v = self.voice(voice_id)
        d = self.voices.root / v["voice_id"]
        ref = d / "ref.wav"
        if not ref.exists():
            raise FireVoiceError("bad_request", "this voice has no reference clip")
        orig = d / "ref.original.wav"
        if not orig.exists():
            shutil.copy2(ref, orig)
        out, sr, check = self.audio_clean(orig, strength)
        tmp = d / "ref.wav.tmp"
        sf.write(str(tmp), out, sr, subtype="PCM_16", format="WAV")
        os.replace(tmp, ref)
        self.voices.update(v["voice_id"], quality_check={**check, "cleaned": strength})
        self._forget_voice(v["voice_id"])
        return {**self.voice(v["voice_id"]), "quality_check": {**check, "cleaned": strength}}

    def voice_restore_original(self, voice_id: str) -> dict:
        import os as _os
        v = self.voice(voice_id)
        d = self.voices.root / v["voice_id"]
        orig = d / "ref.original.wav"
        if not orig.exists():
            raise FireVoiceError("not_found", "this voice has no original clip saved (it was never cleaned)")
        _os.replace(orig, d / "ref.wav")
        self._forget_voice(v["voice_id"])
        return self.voice(v["voice_id"])

    def voice_convert(self, source_path, voice: str, *, lufs: Optional[float] = -16.0, priority: int = 0,
                      cancel: Optional[threading.Event] = None) -> tuple:
        """Voice changer: the words, timing and delivery of `source_path`, in `voice`. -> (audio, sample rate)"""
        import hashlib
        from concurrent.futures import TimeoutError as FutTimeout
        from .core.pool import Voice
        a, sr = self._read(source_path)
        if len(a) / sr > 600:
            raise FireVoiceError("bad_request", "the recording is longer than 10 minutes; split it first")
        if len(a) / sr < 0.5:
            raise FireVoiceError("bad_request", "the recording is too short")
        try:
            v = self.voices.resolve(voice or "default", needs_reference=True, engine="chatterbox-vc")
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))
        except ValueError as e:
            raise FireVoiceError("bad_request", str(e))
        fp = hashlib.sha1(f"{v.get('ref')}|{Path(v['ref']).stat().st_mtime if v.get('ref') else ''}".encode()).hexdigest()[:8]
        pv = Voice(f"{v['voice_id']}#{fp}", ref=v.get("ref"), ref_text=v.get("ref_text"), desc=v.get("desc"))
        ld = self._pool("chatterbox-vc", hold=True)
        group = threading.Event()
        try:
            ld.pool.prepare_voice(pv)
            fut = ld.pool.submit("", pv, {"source": str(Path(source_path).resolve())}, 0, priority=priority, group=group)
            while True:
                try:
                    out = fut.result(timeout=0.25)
                    break
                except FutTimeout:
                    if cancel is not None and cancel.is_set():
                        group.set()
                        raise Cancelled("cancelled")
        except Cancelled:
            raise
        except FireVoiceError:
            raise
        except Exception as e:
            raise FireVoiceError("internal", f"voice changer failed: {str(e)[:300]}")
        finally:
            group.set()
            with self._lock:
                ld.active -= 1
                ld.last_used = time.time()
        out_sr = ld.pool.sr or 24000
        out = np.asarray(out, dtype=np.float32)
        if self._mark_wanted(None, None):
            out = self._mark(out, out_sr, "convert")
        if lufs is not None and len(out) > out_sr // 10:
            out = A.studio_chain(out, out_sr, lufs)
        return out, out_sr

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

    # -------------------------------------------------------------------- design: several candidates, keep the best
    def design_candidates(self, description: str, *, n: int = 3, engine: Optional[str] = None, text: Optional[str] = None,
                          seed: Optional[int] = None, language: Optional[str] = None, priority: int = 0) -> dict:
        """Render `n` takes of a described voice with different seeds, to compare before keeping one.
        -> {batch, description, text, engine, candidates: [{n, seed, duration}]}. Candidates are kept for a day."""
        import random
        import shutil
        import uuid as _uuid
        if not (description or "").strip():
            raise FireVoiceError("bad_request", "a description is required")
        n = max(1, min(6, int(n)))
        eng = self._resolve_engine(engine or ("voxcpm2" if catalog.info("voxcpm2").status()["ready"] else None))
        if not catalog.info(eng).design:
            raise FireVoiceError("bad_request", f"engine {eng} cannot design voices")
        root = home() / "design"
        root.mkdir(parents=True, exist_ok=True)
        for old in root.glob("*"):                 # candidates older than a day go
            try:
                if old.is_dir() and time.time() - old.stat().st_mtime > 86400:
                    shutil.rmtree(old, ignore_errors=True)
            except OSError:
                pass
        batch = _uuid.uuid4().hex[:12]
        d = root / batch
        d.mkdir()
        line = text or DESIGN_TEXT
        base = int(seed if seed is not None else random.randint(1, 2**31 - 1))
        cands = []
        for k in range(n):
            s = base + k * 7919
            r = self.tts(TTSRequest(text=line, engine=eng, voice="design:" + description, style="neutral", instruct="", seed=s, lufs=-20.0,
                                    lead_ms=0, tail_ms=0, validate=False, language=language), priority=priority)
            A.write_audio(d / f"{k + 1}.wav", r.audio, r.sr)
            cands.append({"n": k + 1, "seed": s, "duration": round(r.duration, 2)})
        info = {"batch": batch, "description": description, "text": line, "engine": eng, "language": language, "candidates": cands}
        (d / "batch.json").write_text(json.dumps(info, indent=1), encoding="utf-8")
        return info

    def design_candidate_path(self, batch: str, n: int) -> Path:
        if not re.fullmatch(r"[0-9a-f]{12}", batch or ""):
            raise FireVoiceError("not_found", "unknown design batch")
        p = home() / "design" / batch / f"{int(n)}.wav"
        if not p.exists():
            raise FireVoiceError("not_found", f"design batch {batch} has no candidate {n}")
        return p

    def design_keep(self, batch: str, n: int, name: str, *, gender: str = "", language: str = "", description: Optional[str] = None) -> dict:
        """Keep one candidate as a library voice (locked: the take becomes its reference clip)."""
        p = self.design_candidate_path(batch, n)
        info = json.loads((p.parent / "batch.json").read_text(encoding="utf-8"))
        if not (name or "").strip():
            raise FireVoiceError("bad_request", "a name is required")
        if self.voices.exists(name):
            raise FireVoiceError("conflict", f"voice {name!r} already exists")
        desc = description or info["description"]
        self.voices.add(name, p, consent=True, description=desc, gender=gender, tags=["designed", f"designed:{info['engine']}"],
                        source=f"designed with {info['engine']}", license="synthetic", transcript=info["text"], transcribe=False,
                        extra={"language": language or info.get("language") or None, "design_prompt": desc})
        return self.voice(name)

    # -------------------------------------------------------------------- per-style reference clips
    def voice_build_style_ref(self, voice_id: str, style: str, *, engine: Optional[str] = None, text: Optional[str] = None,
                              seed: int = 1234, priority: int = 0, cancel: Optional[threading.Event] = None) -> dict:
        """Give a voice its own clip for a style: render the voice reading in that style (clip-only cloning, which
        follows the style's instruction), then store it with its transcript as the voice's reference for the style.
        Later renders in that style continue from this clip, so they keep both the voice and the delivery."""
        v = self.voice(voice_id)
        try:
            st = get_style(style)
        except KeyError as e:
            raise FireVoiceError("not_found", str(e).strip("'\""))
        if not st.instruct:
            raise FireVoiceError("bad_request", f"style {style!r} has no delivery instruction to perform")
        eng = self._resolve_engine(engine or "voxcpm2")
        if not catalog.info(eng).instruct:
            raise FireVoiceError("bad_request", f"engine {eng} cannot follow delivery instructions")
        line = (text or st.sample or DESIGN_TEXT).strip()
        line = re.sub(r"\[[^\]]*\]", "", line).strip()       # tags are not spoken in a reference clip
        # A style clip becomes the prompt for every later render in that style, so a bad one (whispered, shouted
        # into noise, or drifting to another speaker) would spoil them all. Up to three seeds; keep the best that is
        # mostly voiced and still clearly this speaker.
        best, report = None, []
        main = self.voices.ref_path(v["voice_id"])
        for k in range(3):
            r = self.tts(TTSRequest(text=line, engine=eng, voice=v["voice_id"], style=style, instruct=st.instruct, seed=seed + k * 7919, lufs=-20.0,
                                    lead_ms=0, tail_ms=0, validate=True, candidates=2, params={"ultimate": False}), priority=priority, cancel=cancel)
            voiced, sim = _clip_checks(r.audio, r.sr, main)
            report.append({"seed": seed + k * 7919, "voiced": round(voiced, 2), "similarity": None if sim is None else round(sim, 3)})
            ok = voiced >= 0.3 and (sim is None or sim >= 0.72)
            score = (sim or 0.8) + min(voiced, 0.6)
            if ok and (best is None or score > best[0]):
                best = (score, r)
            if ok and voiced >= 0.45 and (sim is None or sim >= 0.8):
                break
        if best is None:
            raise FireVoiceError("unavailable", f"could not get a clean {style!r} take of this voice (checked {report}); "
                                                "try another engine or upload your own clip for the style")
        r = best[1]
        tmp = home() / f"_styleref_{os.getpid()}_{threading.get_ident()}.wav"
        A.write_audio(tmp, r.audio, r.sr)
        try:
            self.voices.add_style_ref(v["voice_id"], style, tmp, transcript=line, transcribe=False)
        finally:
            tmp.unlink(missing_ok=True)
        self._forget_voice(v["voice_id"])
        return self.voice(v["voice_id"])

    def voice_remove_style_ref(self, voice_id: str, style: str) -> dict:
        v = self.voice(voice_id)
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,40}", style or ""):
            raise FireVoiceError("bad_request", f"invalid style name {style!r}")
        d = self.voices.root / v["voice_id"] / "refs"
        found = False
        for ext in (".wav", ".txt"):
            f = d / f"{style}{ext}"
            if f.exists():
                f.unlink()
                found = True
        if not found:
            raise FireVoiceError("not_found", f"voice {v['voice_id']} has no clip for style {style!r}")
        self._forget_voice(v["voice_id"])
        return self.voice(v["voice_id"])

    def voice_collections(self) -> list[dict]:
        from .branding import collections
        return collections(self.voice_list())

    # -------------------------------------------------------------------- avatars
    def voice_avatar_path(self, voice_id: str) -> Path:
        v = self.voice(voice_id)
        p = self.voices.root / v["voice_id"] / "avatar.png"
        if not p.exists():
            raise FireVoiceError("not_found", f"voice {v['voice_id']} has no avatar")
        return p

    def voice_set_avatar(self, voice_id: str, data: bytes) -> dict:
        """Any image (png, jpg, webp...): centre-cropped to a square and stored as a 512x512 PNG."""
        import io
        from PIL import Image, UnidentifiedImageError
        v = self.voice(voice_id)
        try:
            im = Image.open(io.BytesIO(data))
            im.load()
        except (UnidentifiedImageError, OSError) as e:
            raise FireVoiceError("bad_request", f"not an image: {e}")
        if im.width < 64 or im.height < 64:
            raise FireVoiceError("bad_request", "the image is too small (at least 64x64)")
        im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
        side = min(im.size)
        left, top = (im.width - side) // 2, (im.height - side) // 2
        im = im.crop((left, top, left + side, top + side)).resize((512, 512), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        _atomic_write(self.voices.root / v["voice_id"] / "avatar.png", buf.getvalue())
        return self.voice(v["voice_id"])

    def voice_remove_avatar(self, voice_id: str) -> dict:
        v = self.voice(voice_id)
        (self.voices.root / v["voice_id"] / "avatar.png").unlink(missing_ok=True)
        return self.voice(v["voice_id"])

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

    def setup_report(self) -> dict:
        """First-run facts for any client: the GPU, a recommended engine for it, what is ready, and what is missing."""
        from . import paths
        from .core.gpu import gpu_info
        g = gpu_info()
        vram = g.get("vram_total_gb")
        engines = {e["name"]: e for e in self.engines()}

        def pick(name: str, why: str) -> dict:
            e = engines.get(name, {})
            return {"engine": name, "title": e.get("title", name), "model": e.get("model"), "tier": e.get("tier"), "reason": why, "ready": bool(e.get("ready")),
                    "installable": bool(e.get("installable")), "vram_gb": e.get("vram_gb")}
        if not g:
            rec = pick("kokoro", "No NVIDIA GPU found: Spark is small enough to run on the CPU (preset voices, no cloning).")
            alts = []
        elif (vram or 0) >= 9:
            rec = pick("voxcpm2", f"{vram:.0f} GB of VRAM fits Inferno, the most natural engine here: 48 kHz, cloning, "
                                  "voice design and style instructions in 30 languages.")
            alts = [pick("chatterbox-turbo", "Faster, smaller and ready without a download."),
                    pick("qwen3-tts", "Strong 3-second cloning in 10 languages.")]
        elif (vram or 0) >= 4.5:
            rec = pick("chatterbox-turbo", f"{vram:.0f} GB of VRAM: Flash clones voices quickly and comes with the backend.")
            alts = [pick("qwen3-tts", "Better cloning in 10 languages, if it fits next to other apps."),
                    pick("kokoro", "Tiny and very fast, preset voices only.")]
        else:
            rec = pick("kokoro", f"Only {vram or 0:.0f} GB of VRAM: Spark needs about 1 GB (preset voices, no cloning).")
            alts = [pick("chatterbox-turbo", "Cloning, if about 4 GB of VRAM is free.")]
        ff = paths.ffmpeg()
        problems = []
        if not ff:
            problems.append("ffmpeg not found: install it, or set its path in settings")
        if not any(e.get("ready") for n, e in engines.items() if n != "null"):
            problems.append("no engine is installed yet")
        return {"gpu": g or None, "vram_gb": vram, "recommended": rec, "alternatives": alts, "ffmpeg": ff,
                "voices": len(self.voices.list()), "ready_engines": sorted(n for n, e in engines.items() if e.get("ready") and n != "null"),
                "problems": problems}

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
            "favorite", "notes", "avatar", "quality_check")
    d = {k: v.get(k) for k in keep if k in v}
    d.setdefault("language", "en")
    d["kind"] = "designed" if ("designed" in (v.get("tags") or []) or v.get("category") == "designed") else "cloned"
    d["default"] = v["voice_id"] == default
    return d


def _language_param(inf, code: str):
    """Map an ISO code onto an engine's language parameter (Qwen wants English names)."""
    p = inf.param("language")
    if p is not None and p.type == "enum" and code.split("-")[0] in (p.choices or []):
        return code.split("-")[0]
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


def _avatar_version(voice_dir: Path) -> Optional[int]:
    """The avatar's modification time (a cache-busting version for its URL), or None when the voice has none."""
    try:
        return int((Path(voice_dir) / "avatar.png").stat().st_mtime)
    except OSError:
        return None


def _loop_to(a: np.ndarray, n: int, sr: int, xfade_s: float = 1.5) -> np.ndarray:
    """Repeat `a` (a music bed) to `n` samples with crossfaded joins."""
    a = np.asarray(a, dtype=np.float32)
    if len(a) >= n or not len(a):
        return a[:n].copy() if len(a) else np.zeros(n, np.float32)
    x = min(int(xfade_s * sr), len(a) // 3)
    out = a.copy()
    ramp = np.linspace(0, 1, x, dtype=np.float32)
    while len(out) < n:
        out[-x:] = out[-x:] * (1 - ramp) + a[:x] * ramp
        out = np.concatenate([out, a[x:]])
    return out[:n]


def _task(engine: str) -> str:
    try:
        return catalog.info(engine).task
    except Exception:
        return "tts"


def _clip_checks(a: np.ndarray, sr: int, ref_path: Optional[str]) -> tuple:
    """-> (share of 20 ms frames that are voiced speech, speaker similarity to the reference clip or None)."""
    import librosa
    y = librosa.resample(np.asarray(a, dtype=np.float32), orig_sr=sr, target_sr=16000) if sr != 16000 else np.asarray(a, dtype=np.float32)
    try:
        _f0, vf, _p = librosa.pyin(y, fmin=60, fmax=600, sr=16000, frame_length=1024)
        rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=256)[0]
        speech = rms > rms.max() * 0.05
        n = min(len(vf), len(speech))
        voiced = float(vf[:n][speech[:n]].mean()) if speech[:n].any() else 0.0
    except Exception:
        voiced = 1.0
    sim = None
    if ref_path:
        try:
            from resemblyzer import VoiceEncoder, preprocess_wav
            import soundfile as sf
            enc = _clip_checks.__dict__.setdefault("enc", VoiceEncoder(device="cpu"))
            r, rsr = sf.read(ref_path, dtype="float32", always_2d=False)
            r = r.mean(axis=1) if r.ndim > 1 else r
            sim = float(enc.embed_utterance(preprocess_wav(y, 16000)) @ enc.embed_utterance(preprocess_wav(r, rsr)))
        except Exception:
            sim = None
    return voiced, sim
