"""Stop means stop: a cancelled render drops its queued GPU work, interactive renders go first, and a stopped engine
fails what was waiting instead of hanging."""
import threading
import time

import pytest

from firevoice.core.pool import EnginePool
from firevoice.core.registry import get_engine
from firevoice.types import Cancelled

LONG = " ".join(f"This is sentence number {i} of a rather long script that keeps going." for i in range(12))


def _pool(delay=0.25, workers=1):
    spec = get_engine("null")
    spec.adapter_kwargs = {"delay": delay}
    return EnginePool(spec, workers=workers).start()


def test_cancelled_render_drops_its_queued_work(make):
    s = make(workers=1, adapter_kwargs={"delay": 0.25})
    s.pool.start()        # worker start-up (1-3 s on Windows) is not what this measures
    cancel = threading.Event()
    done_before = s.pool.stats["jobs"]
    t0 = time.perf_counter()
    threading.Timer(0.6, cancel.set).start()
    with pytest.raises(Cancelled):
        s.speak(LONG, voice="design:test", cancel=cancel)
    assert time.perf_counter() - t0 < 2.0                    # 12 sentences x 0.25 s would take 3 s or more
    time.sleep(0.6)
    ran = sum(w.jobs_done for w in s.pool.workers)
    assert ran <= 5, f"{ran} generations ran after a cancel at 0.6 s"
    assert s.pool.stats["jobs"] - done_before >= 12           # they were all queued, then dropped


def test_interactive_work_jumps_the_background_queue():
    pool = _pool(delay=0.15)
    try:
        bg = [pool.submit(f"background {i}", None, {}, i, priority=1) for i in range(8)]
        time.sleep(0.05)
        fg = pool.submit("someone is waiting", None, {}, 99, priority=0)
        fg.result(timeout=5)
        finished_bg = sum(f.done() for f in bg)
        assert finished_bg <= 2, f"{finished_bg} background generations ran before the interactive one"
        for f in bg:
            f.result(timeout=10)
    finally:
        pool.stop()


def test_group_cancel_and_stop_fail_waiting_work():
    pool = _pool(delay=0.3)
    group = threading.Event()
    futs = [pool.submit(f"line {i}", None, {}, i, group=group) for i in range(6)]
    time.sleep(0.1)
    group.set()
    errs = []
    for f in futs:
        try:
            f.result(timeout=5)
        except Cancelled:
            errs.append("cancelled")
    assert errs.count("cancelled") >= 4
    waiting = [pool.submit(f"more {i}", None, {}, i) for i in range(5)]
    pool.stop()
    for f in waiting:
        with pytest.raises(Exception):
            f.result(timeout=5)                               # never hangs


def test_api_errors_stay_json(svc):
    from fastapi.testclient import TestClient

    from firevoice.server import create_app
    c = TestClient(create_app(svc), raise_server_exceptions=False)
    r = c.post("/api/v1/jobs", json={"kind": "tts", "payload": {"request": {"text": "Hi.", "pace": "fast"}}})
    assert r.status_code == 400 and "pace" in r.json()["error"]["message"]
    r = c.post("/api/v1/jobs", json={"kind": "batch", "payload": {"lines": ["not an object"]}})
    assert r.status_code == 400
    r = c.delete("/api/v1/styles/..%5C..%5Cvoices%5Cx%5Cmeta")
    assert r.status_code in (400, 404) and "error" in r.json()
    r = c.post("/api/v1/voices/brand", params={"only": "no-such-voice"})
    assert r.status_code == 404


def test_stop_a_generation_mid_take():
    """A step-by-step engine stops inside a take once its render is cancelled, and keeps serving afterwards."""
    import dataclasses
    spec = dataclasses.replace(get_engine("null"), adapter_kwargs={"stream": "1", "delay": 0.4})
    pool = EnginePool(spec, workers=1).start()
    try:
        group = threading.Event()
        long_text = " ".join(["word"] * 120)          # ~38 s of audio: ~15 s to generate at this pace
        t0 = time.time()
        fut = pool.submit(long_text, None, {}, 1, group=group)
        time.sleep(1.5)
        group.set()
        with pytest.raises(Cancelled):
            fut.result(timeout=10)
        assert time.time() - t0 < 5, "the take should stop within moments, not run to the end"
        ok = pool.submit("short and sweet", None, {}, 2).result(timeout=20)
        assert len(ok) > 0
    finally:
        pool.stop()
