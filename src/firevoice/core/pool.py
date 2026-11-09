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
import os
import queue
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
from .registry import EngineSpec, get_engine


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
        cmd = [spec.python, "-X", "utf8", "-m", "firevoice.core.worker", "--engine", spec.adapter, "--scratch", str(self.pool.scratch), "--parent-pid", str(os.getpid())]
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
        self._logf = open(self.log, "a", encoding="utf-8", errors="replace")
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._logf, text=True, encoding="utf-8", bufsize=1, cwd=str(spec.cwd) if spec.cwd else None, env=env)
        self.voices.clear()
        ready = self._read(timeout=self.pool.spec.start_timeout)
        if not ready or ready.get("event") != P.READY:
            raise RuntimeError(f"worker {self.index} did not start (see {self.log})")
        r = self.request({"op": "load"}, timeout=self.pool.spec.load_timeout)
        if not r.get("ok"):
            raise RuntimeError(f"worker {self.index} failed to load: {r.get('error')} (see {self.log})")
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

    def request(self, req: dict, timeout: float) -> dict:
        if not self.alive():
            return {"ok": False, "error": "worker not running", "kind": "crash"}
        req.setdefault("id", uuid.uuid4().hex[:12])
        try:
            P.send(req, self.proc.stdin)
        except Exception as e:
            return {"ok": False, "error": f"send failed: {e}", "kind": "crash"}
        while True:
            r = self._read(timeout)
            if r is None:
                return {"ok": False, "error": f"timeout after {timeout}s", "kind": "hang"}
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
        return self.request({"op": "synth", "text": job.text, "voice_id": job.voice.voice_id if job.voice else None, "params": job.params, "seed": job.seed}, timeout=self.pool.spec.synth_timeout)


class EnginePool:
    def __init__(self, engine: str | EngineSpec, workers: Optional[int] = None, device: Optional[str] = None, scratch: Optional[str | Path] = None,
                 log_dir: Optional[str | Path] = None, max_retries: int = 2):
        self.spec = engine if isinstance(engine, EngineSpec) else get_engine(engine)
        self.device = device
        self.src_dir = Path(__file__).resolve().parents[2]
        self.scratch = Path(scratch) if scratch else Path(tempfile.mkdtemp(prefix="firevoice-"))
        self.scratch.mkdir(parents=True, exist_ok=True)
        self.log_dir = Path(log_dir) if log_dir else Path(os.environ.get("FIREVOICE_HOME", Path.home() / ".firevoice")) / "logs"
        self.n = max(1, int(workers or self.spec.default_workers))
        self.max_retries = max_retries
        self.workers: list[_Worker] = []
        self.q: "queue.Queue[Job | None]" = queue.Queue()
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
            sys.stderr.write(f"[firevoice] {self.spec.name}: only {fit} of {self.n} model copies fit in free VRAM, running {fit}\n")
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
            sys.stderr.write(f"[firevoice] {self.spec.name}: {len(self.workers)}/{self.n} workers started ({errs[0][:160]})\n")
        self.workers.sort(key=lambda w: w.index)
        for w in self.workers:
            th = threading.Thread(target=self._loop, args=(w,), daemon=True, name=f"{self.spec.name}-{w.index}")
            th.start()
            self.threads.append(th)
        self.started = True
        self.boot_seconds = round(time.perf_counter() - t0, 2)
        return self

    def stop(self) -> None:
        for _ in self.workers:
            self.q.put(None)
        for w in self.workers:
            w.stop()
        self.started = False

    def __enter__(self):
        return self.start()

    def __exit__(self, *a):
        self.stop()

    @property
    def caps(self) -> dict:
        return self.workers[0].caps if self.workers else {}

    # -- scheduling ------------------------------------------------------------------
    def submit(self, text: str, voice: Optional[Voice], params: Optional[dict] = None, seed: int = 0) -> Future:
        if not self.started:
            self.start()
        job = Job(text=text, voice=voice, params=params or {}, seed=seed)
        self.stats["jobs"] += 1
        self.q.put(job)
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
            job = self.q.get()
            if job is None:
                return
            if job.future.cancelled():
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
            if kind == "oom":
                self.stats["oom"] += 1
                self.oom_until = time.time() + 30
            # restart only a worker that is actually gone or hung; a healthy worker that raised keeps serving
            if not w.alive() or kind == "hang":
                self.stats["restarts"] += 1
                self._restart(w)
            job.attempts += 1
            if kind != "bad_input" and job.attempts <= self.max_retries:
                self.stats["retries"] += 1
                self.q.put(job)
            else:
                job.future.set_exception(RuntimeError(f"{self.spec.name}: {r.get('error')}"))

    def _restart(self, w: _Worker) -> None:
        try:
            w.stop()
        except Exception:
            pass
        for attempt in range(3):
            try:
                w.start()
                return
            except Exception as e:
                sys.stderr.write(f"[firevoice] restart of {self.spec.name}-{w.index} failed ({attempt + 1}/3): {str(e)[:200]}\n")
                time.sleep(2 * (attempt + 1))

    def worker_stats(self) -> list[dict]:
        out = []
        for w in self.workers:
            with w.lock:
                r = w.request({"op": "stats"}, timeout=10) if w.alive() else {"ok": False}
            out.append({"index": w.index, "alive": w.alive(), "jobs_done": w.jobs_done, "voices": sorted(w.voices), **{k: v for k, v in r.items() if k not in ("id", "ok")}})
        return out
