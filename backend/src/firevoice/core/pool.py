"""EnginePool: supervises N worker processes for one engine and hands out jobs.

Robustness rules
  * a worker that dies (CUDA crash, access violation, OOM-kill) is restarted and its job is retried on
    another worker, up to `max_retries` times
  * an "oom" reply lowers the pool's active worker count for a while (backoff) instead of failing the job
  * jobs are plain futures: the scheduler can fan out hundreds and gather them in any order
  * per-worker voice cache: a job is routed to a worker that already has the voice when possible, else the
    voice is prepared on the chosen worker first
"""
from __future__ import annotations

import json
import itertools
import logging
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np

from . import protocol as P
from ..paths import entry as _entry, home as _home
from .registry import EngineSpec, get_engine
from ..types import Cancelled


def _kill_tree(proc: subprocess.Popen) -> None:
    """Kill a worker *and its children*. A venv's python.exe on Windows is a launcher stub whose child is the
    real interpreter holding the GPU memory; killing only the stub leaks a 5 GB zombie."""
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        else:
            try:
                import signal
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                proc.kill()
    except Exception:
        pass
    try:
        proc.kill()
    except Exception:
        pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass


_log = logging.getLogger("firevoice")


@dataclass
class Voice:
    voice_id: str
    ref: Optional[str] = None
    ref_text: Optional[str] = None
    desc: Optional[str] = None


@dataclass
class Job:
    text: str
    voice: Optional[Voice]
    params: dict
    seed: int
    future: Future = field(default_factory=Future)
    attempts: int = 0
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])
    priority: int = 0                         # 0 = someone is waiting (an API render), 1 = background job
    on_part: Optional[object] = None          # callable(np.ndarray): stream pieces of this generation as they decode
    parts_sent: int = 0
    group: Optional[threading.Event] = None   # set = the render this belongs to was cancelled: drop, do not run


class _Worker:
    def __init__(self, pool: "EnginePool", index: int):
        self.pool = pool
        self.index = index
        self.proc: Optional[subprocess.Popen] = None
        self.voices: set[str] = set()
        self.lock = threading.Lock()
        self.sr = 0
        self.caps: dict = {}
        self.busy = False
        self.jobs_done = 0
        self.log = pool.log_dir / f"{pool.spec.name}-{index}.log"

    # -- process -------------------------------------------------------------
    def start(self) -> None:
        spec = self.pool.spec
        self.pool.scratch.mkdir(parents=True, exist_ok=True)   # removed when the pool last stopped
        cmd = [spec.python, "-X", "utf8", *_entry("firevoice.core.worker"), "--engine", spec.adapter, "--scratch", str(self.pool.scratch), "--parent-pid", str(os.getpid())]
        if self.pool.device:
            cmd += ["--device", self.pool.device]
        if spec.adapter_kwargs:
            cmd += ["--kw", *[f"{k}={v}" for k, v in spec.adapter_kwargs.items()]]
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(self.pool.src_dir), *spec.extra_pythonpath, env.get("PYTHONPATH", "")]))
        env["PYTHONUNBUFFERED"] = "1"
        env.setdefault("PYTHONIOENCODING", "utf-8")
        # less fragmentation in the caching allocator -> several model copies share the card without paging
        env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        for k, v in spec.env.items():
            env[k] = v
        self.log.parent.mkdir(parents=True, exist_ok=True)
        try:                                   # keep one older log; a log never grows past about 5 MB
            if self.log.exists() and self.log.stat().st_size > 5_000_000:
                os.replace(self.log, self.log.with_suffix(self.log.suffix + ".1"))
        except OSError:
            pass
        self._logf = open(self.log, "a", encoding="utf-8", errors="replace")
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._logf, text=True, encoding="utf-8", bufsize=1, cwd=str(spec.cwd) if spec.cwd else None, env=env)
        self.voices.clear()
        ready = self._read(timeout=self.pool.spec.start_timeout)
        if not ready or ready.get("event") != P.READY:
            raise RuntimeError(f"{self.pool.spec.name} did not start; its log is {self.log}")
        r = self.request({"op": "load"}, timeout=self.pool.spec.load_timeout)
        if not r.get("ok"):
            raise RuntimeError(f"{self.pool.spec.name} could not load: {r.get('error')} (log: {self.log})")
        self.sr = int(r["sr"])
        self.caps = r.get("caps", {})

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self, grace: float = 5.0) -> None:
        if self.proc is None:
            return
        try:
            if self.alive():
                P.send({"op": "quit", "id": "q"}, self.proc.stdin)
                self.proc.wait(timeout=grace)
        except Exception:
            pass
        if self.alive():
            _kill_tree(self.proc)
        try:
            self._logf.close()
        except Exception:
            pass
        self.proc = None

    def _read(self, timeout: float) -> Optional[dict]:
        """Read one reply with a timeout (a hung CUDA kernel must not hang the supervisor)."""
        box: list = []

        def rd():
            try:
                box.append(P.recv(self.proc.stdout))
            except Exception as e:
                box.append({"ok": False, "error": str(e), "kind": "crash"})

        t = threading.Thread(target=rd, daemon=True)
        t.start()
        t.join(timeout)
        if t.is_alive():
            return None
        return box[0] if box else None

    def request(self, req: dict, timeout: float, on_event=None, group: Optional[threading.Event] = None) -> dict:
        if not self.alive():
            return {"ok": False, "error": "worker not running", "kind": "crash"}
        req.setdefault("id", uuid.uuid4().hex[:12])
        try:
            P.send(req, self.proc.stdin)
        except Exception as e:
            return {"ok": False, "error": f"send failed: {e}", "kind": "crash"}
        stop_file = self.pool.scratch / f"{req['id']}.stop"
        done = threading.Event()
        if group is not None:
            def watch():
                # the worker cannot read stdin while it generates; a stop file in the shared scratch folder reaches it
                while not done.wait(0.1):
                    if group.is_set():
                        try:
                            stop_file.touch()
                        except OSError:
                            pass
                        return
            threading.Thread(target=watch, daemon=True, name="fv-stop-watch").start()
        try:
            return self._await(req, timeout, on_event)
        finally:
            done.set()
            try:
                stop_file.unlink(missing_ok=True)
            except OSError:
                pass

    def _await(self, req: dict, timeout: float, on_event=None) -> dict:
        while True:
            r = self._read(timeout)
            if r is None:
                return {"ok": False, "error": f"timeout after {timeout}s", "kind": "hang"}
            if r.get("event") == "part" and r.get("id") == req["id"]:
                if on_event is not None:
                    on_event(r)
                continue
            if r.get("id") == req["id"] or r.get("id") is None:
                return r

    # -- work ------------------------------------------------------------------
    def ensure_voice(self, v: Voice) -> dict:
        if v.voice_id in self.voices:
            return {"ok": True}
        r = self.request({"op": "voice", "voice_id": v.voice_id, "ref": v.ref, "ref_text": v.ref_text, "desc": v.desc}, timeout=self.pool.spec.load_timeout)
        if r.get("ok"):
            self.voices.add(v.voice_id)
        return r

    def run(self, job: Job) -> dict:
        if job.voice is not None:
            r = self.ensure_voice(job.voice)
            if not r.get("ok"):
                return r
        req = {"op": "synth", "text": job.text, "voice_id": job.voice.voice_id if job.voice else None, "params": job.params, "seed": job.seed}
        if job.on_part is None or not self.caps.get("streaming"):
            if job.group is not None and self.caps.get("streaming"):
                req["stoppable"] = True        # step-by-step engines stop mid-take when the render is cancelled
            return self.request(req, timeout=self.pool.spec.synth_timeout, group=job.group)

        def part(r):
            try:
                a = np.load(r["path"])
                os.remove(r["path"])
            except Exception:
                return
            job.parts_sent += 1
            try:
                job.on_part(a)
            except Exception:
                pass
        return self.request({**req, "op": "synth_stream"}, timeout=self.pool.spec.synth_timeout, on_event=part, group=job.group)


class EnginePool:
    def __init__(self, engine: str | EngineSpec, workers: Optional[int] = None, device: Optional[str] = None, scratch: Optional[str | Path] = None,
                 log_dir: Optional[str | Path] = None, max_retries: int = 2):
        self.spec = engine if isinstance(engine, EngineSpec) else get_engine(engine)
        self.device = device
        from ..paths import worker_src
        self.src_dir = worker_src()   # src/ in a checkout; an isolated copy of the package when installed
        self._own_scratch = scratch is None      # a folder made here is removed again on stop
        self.scratch = Path(scratch) if scratch else Path(tempfile.mkdtemp(prefix="firevoice-"))
        self.scratch.mkdir(parents=True, exist_ok=True)
        self.log_dir = Path(log_dir) if log_dir else _home() / "logs"
        self.n = max(1, int(workers or self.spec.default_workers))
        self.max_retries = max_retries
        self.workers: list[_Worker] = []
        # (priority, order, job): interactive renders go ahead of background jobs, otherwise first come first served
        self.q: "queue.PriorityQueue" = queue.PriorityQueue()
        self._order = itertools.count()
        self._stopping = False
        self.threads: list[threading.Thread] = []
        self.started = False
        self.lock = threading.Lock()
        self._start_lock = threading.Lock()
        self.oom_until = 0.0
        self.stats = {"jobs": 0, "retries": 0, "restarts": 0, "oom": 0}
        self.sr = 0

    # -- lifecycle -----------------------------------------------------------------
    def fit_workers(self, reserve_gb: float = 3.5) -> int:
        """How many model copies fit in the VRAM that is free right now (keeping `reserve_gb` for the ASR
        model and headroom). Oversubscribing VRAM on Windows makes the driver page to system RAM and the
        GPU runs 10-30x slower, so this cap matters more than raw parallelism."""
        from .gpu import free_vram_gb
        if self.spec.vram_gb <= 0:
            return self.n
        free = free_vram_gb()
        if free is None:
            return self.n
        fit = int((free - reserve_gb) // max(0.5, self.spec.vram_gb))
        return max(1, min(self.n, fit))

    def start(self) -> "EnginePool":
        """Idempotent and thread-safe: concurrent callers (several `speak()` threads) must share ONE set of
        workers, otherwise each would boot its own copies and oversubscribe the GPU."""
        if self.started:
            return self
        with self._start_lock:
            if self.started:
                return self
            return self._start()

    def _start(self) -> "EnginePool":
        t0 = time.perf_counter()
        fit = self.fit_workers()
        if fit < self.n:
            _log.warning("%s: only %d of %d copies fit in free GPU memory, running %d", self.spec.name, fit, self.n, fit)
            self.n = fit
        first = _Worker(self, 0)
        first.start()           # fail fast on the first; the rest start in parallel
        self.workers.append(first)
        self.sr = first.sr
        errs: list[str] = []

        def boot(i):
            w = _Worker(self, i)
            try:
                w.start()
                with self.lock:
                    self.workers.append(w)
            except Exception as e:
                errs.append(str(e))

        ts = [threading.Thread(target=boot, args=(i,), daemon=True) for i in range(1, self.n)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        if errs and len(self.workers) < self.n:
            # fewer copies fit than asked (VRAM): run with what we have, say so
            _log.warning("%s: %d of %d copies started (%s)", self.spec.name, len(self.workers), self.n, errs[0][:160])
        self.workers.sort(key=lambda w: w.index)
        for w in self.workers:
            th = threading.Thread(target=self._loop, args=(w,), daemon=True, name=f"{self.spec.name}-{w.index}")
            th.start()
            self.threads.append(th)
        self.started = True
        self.boot_seconds = round(time.perf_counter() - t0, 2)
        return self

    def _put(self, job: Optional[Job]) -> None:
        self.q.put((-1 if job is None else job.priority, next(self._order), job))

    def stop(self) -> None:
        """Stop the workers. Requests still queued fail at once with "engine stopped" instead of waiting forever."""
        self._stopping = True
        self.started = False
        while True:
            try:
                _, _, job = self.q.get_nowait()
            except queue.Empty:
                break
            if job is not None and not job.future.done():
                job.future.set_exception(RuntimeError(f"{self.spec.name} was stopped before this finished"))
        for _ in self.workers:
            self._put(None)
        for w in self.workers:
            w.stop()
        if self._own_scratch:
            shutil.rmtree(self.scratch, ignore_errors=True)

    def __enter__(self):
        return self.start()

    def __exit__(self, *a):
        self.stop()

    @property
    def caps(self) -> dict:
        return self.workers[0].caps if self.workers else {}

    # -- scheduling ------------------------------------------------------------------
    def submit(self, text: str, voice: Optional[Voice], params: Optional[dict] = None, seed: int = 0, *, priority: int = 0,
               group: Optional[threading.Event] = None, on_part=None) -> Future:
        """Queue one generation. `priority` 0 runs before 1 (background jobs). `group`: an Event shared by every request
        of one render; once it is set, requests of that render still in the queue are dropped without touching the GPU."""
        if not self.started:
            self.start()
        if getattr(self, "broken", None):
            f: Future = Future()
            f.set_exception(RuntimeError(self.broken))
            return f
        job = Job(text=text, voice=voice, params=params or {}, seed=seed, priority=priority, group=group, on_part=on_part)
        with self.lock:
            self.stats["jobs"] += 1
        self._put(job)
        return job.future

    def synth(self, text: str, voice: Optional[Voice], params: Optional[dict] = None, seed: int = 0, timeout: Optional[float] = None) -> np.ndarray:
        return self.submit(text, voice, params, seed).result(timeout)

    def prepare_voice(self, voice: Voice) -> None:
        """Warm a voice on every worker now (so the first real job does not pay for it)."""
        if not self.started:
            self.start()
        for w in self.workers:
            with w.lock:
                w.ensure_voice(voice)

    def _loop(self, w: _Worker) -> None:
        while True:
            _, _, job = self.q.get()
            if job is None:
                return
            if job.attempts == 0 and not job.future.set_running_or_notify_cancel():
                continue                  # Future.cancel() was called while it waited
            if job.group is not None and job.group.is_set():
                job.future.set_exception(Cancelled("render cancelled"))
                continue
            if self._stopping:
                job.future.set_exception(RuntimeError(f"{self.spec.name} was stopped before this finished"))
                continue
            while time.time() < self.oom_until and w.index > 0:
                time.sleep(0.2)       # backoff: only worker 0 keeps going after an OOM
            with w.lock:
                w.busy = True
                r = w.run(job) if w.alive() else {"ok": False, "error": "worker dead", "kind": "crash"}
                w.busy = False
            if r.get("ok"):
                try:
                    a = np.load(r["path"])
                    os.remove(r["path"])
                except Exception as e:
                    r = {"ok": False, "error": f"result read failed: {e}", "kind": "crash"}
                else:
                    w.jobs_done += 1
                    job.future.set_result(a)
                    continue
            kind = r.get("kind", "crash")
            if kind == "cancelled":
                job.future.set_exception(Cancelled("render cancelled"))
                continue
            if kind == "oom":
                self.stats["oom"] += 1
                self.oom_until = time.time() + 30
            # restart only a worker that is actually gone or hung; a healthy worker that raised keeps serving
            if not w.alive() or kind == "hang":
                self.stats["restarts"] += 1
                if not self._restart(w):
                    # it will not come back: stop serving from this slot so it cannot burn other requests' retries
                    w.dead = True
                    if any(not getattr(x, "dead", False) for x in self.workers):
                        self._put(job)            # another worker takes it, without spending a retry
                    else:
                        self.broken = f"{self.spec.name} stopped working and could not restart ({str(r.get('error'))[:160]})"
                        job.future.set_exception(RuntimeError(self.broken))
                        self._fail_queued(self.broken)
                    return
            job.attempts += 1
            if job.parts_sent:
                # part of this take was already played to someone: a fresh take would not match it, so fail instead
                job.future.set_exception(RuntimeError(f"{self.spec.name} failed partway through: {r.get('error')}"))
                continue
            if kind != "bad_input" and job.attempts <= self.max_retries and not self._stopping and not (job.group and job.group.is_set()):
                with self.lock:
                    self.stats["retries"] += 1
                self._put(job)
            else:
                job.future.set_exception(RuntimeError(f"{self.spec.name}: {r.get('error')}"))

    def _restart(self, w: _Worker) -> bool:
        try:
            w.stop()
        except Exception:
            pass
        for attempt in range(3):
            try:
                w.start()
                return True
            except Exception as e:
                _log.warning("restart of %s-%d failed (%d/3): %s", self.spec.name, w.index, attempt + 1, str(e)[:200])
                time.sleep(2 * (attempt + 1))
        return False

    def _fail_queued(self, message: str) -> None:
        while True:
            try:
                _, _, job = self.q.get_nowait()
            except queue.Empty:
                return
            if job is not None and not job.future.done():
                job.future.set_exception(RuntimeError(message))

    def worker_stats(self) -> list[dict]:
        out = []
        for w in self.workers:
            with w.lock:
                r = w.request({"op": "stats"}, timeout=10) if w.alive() else {"ok": False}
            out.append({"index": w.index, "alive": w.alive(), "jobs_done": w.jobs_done, "voices": sorted(w.voices), **{k: v for k, v in r.items() if k not in ("id", "ok")}})
        return out
