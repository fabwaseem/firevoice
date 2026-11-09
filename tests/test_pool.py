"""The worker pool: parallelism, crash recovery, error classification. CPU only (null adapter)."""
import time

import pytest

from firevoice.core.pool import EnginePool, Voice
from firevoice.core.registry import all_engines, get_engine


def spec(**kw):
    s = get_engine("null")
    s.adapter_kwargs = {k: str(v) for k, v in kw.items()}
    return s


def test_jobs_spread_over_workers():
    with EnginePool(spec(delay=0.1), workers=3) as p:
        futs = [p.submit(f"job {i}", None, {}, i) for i in range(9)]
        t0 = time.time()
        outs = [f.result(20) for f in futs]
        assert time.time() - t0 < 0.75          # 9 x 0.1 s serial would be 0.9 s
        assert all(len(a) > 0 for a in outs)
        assert sorted(w["jobs_done"] for w in p.worker_stats()) == [3, 3, 3]
        assert p.caps["supports_tags"] is True and p.sr == 24000


def test_model_error_is_retried_then_reported_and_worker_survives():
    with EnginePool(spec(fail_on="BOOM"), workers=1, max_retries=2) as p:
        with pytest.raises(RuntimeError):
            p.submit("please BOOM", None, {}, 1).result(20)
        # a model RuntimeError is retried (it may be transient) but never restarts a healthy worker
        assert p.stats["retries"] == 2 and p.stats["restarts"] == 0
        assert len(p.submit("fine", None, {}, 1).result(20)) > 0
        assert p.workers[0].alive()


def test_dead_worker_is_restarted():
    with EnginePool(spec(), workers=1) as p:
        p.workers[0].proc.kill()
        time.sleep(0.3)
        a = p.submit("after the crash", None, {}, 1).result(60)
        assert len(a) > 0 and p.stats["restarts"] >= 1 and p.workers[0].alive()


def test_stop_kills_the_whole_worker_tree():
    """The venv python.exe is a launcher stub on Windows; stop() must take the real interpreter down with it."""
    import subprocess
    p = EnginePool(spec(), workers=1).start()
    stub_pid = p.workers[0].proc.pid
    p.workers[0].stop(grace=0.01)   # no time to quit politely -> forced tree kill
    time.sleep(3.0)
    if subprocess.os.name == "nt":
        out = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*firevoice.core.worker*' -and $_.CommandLine -like '*" + p.scratch.name + "*' }).Count"],
                             capture_output=True, text=True).stdout.strip()
        assert out in ("", "0"), f"leaked worker processes: {out} (stub {stub_pid})"
    p.stop()


def test_voice_prepared_once_per_worker():
    with EnginePool(spec(), workers=2) as p:
        v = Voice("v1", ref=None, desc="x")
        p.prepare_voice(v)
        assert all("v1" in w.voices for w in p.workers)
        assert len(p.submit("hello", v, {}, 1).result(20)) > 0


def test_concurrent_start_boots_one_set_of_workers():
    """Regression: parallel speak() callers used to each boot their own workers (2 x 2 = 4 copies on the GPU)."""
    from concurrent.futures import ThreadPoolExecutor
    p = EnginePool(spec(), workers=2)
    try:
        with ThreadPoolExecutor(4) as ex:
            list(ex.map(lambda _: p.start(), range(4)))
        assert len(p.workers) == 2 and len(p.threads) == 2
        futs = [p.submit(f"job {i}", None, {}, i) for i in range(6)]
        assert all(len(f.result(30)) > 0 for f in futs)
    finally:
        p.stop()


def test_registry_lists_known_engines():
    names = set(all_engines())
    assert {"null", "chatterbox-turbo", "qwen3-tts", "voxcpm2", "dots", "indextts2", "breeze", "kokoro"} <= names
    assert get_engine("turbo").name == "chatterbox-turbo"
