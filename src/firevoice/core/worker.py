"""Engine worker process. Started by EnginePool with the engine venv's python:

    python -X utf8 -m firevoice.core.worker --engine chatterbox-turbo --scratch <dir> [--device cuda:0] [--kw k=v ...]

Only numpy is needed by the package import path; the adapter imports torch and the model lazily. The
worker is single-threaded by design: one model copy, one job at a time. Parallelism comes from the pool
running several workers (and, for engines that are stateless under the hood, several copies on one GPU).
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import traceback
from pathlib import Path

import numpy as np


def _parent_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            k32.GetExitCodeProcess(h, ctypes.byref(code))
            return code.value == 259  # STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _watch_parent(pid: int) -> None:
    """A supervisor killed with -9 cannot tell us to quit; poll it and hard-exit so no GPU memory is orphaned."""
    import threading

    launcher = os.getppid()   # the venv's python.exe stub on Windows; if the pool killed it, we must go too

    def loop():
        while True:
            time.sleep(2.0)
            if not _parent_alive(pid) or (launcher and launcher != pid and not _parent_alive(launcher)):
                os._exit(3)

    threading.Thread(target=loop, daemon=True, name="parent-watch").start()


def _trim_cuda_cache(ratio: float = 1.4) -> None:
    """Variable-length generations fragment PyTorch's caching allocator; several workers on one card can then
    reserve far more than they use and push the driver into paging. Give memory back when the cache has grown
    well beyond what is live."""
    try:
        import torch
        if torch.cuda.is_available():
            alloc, reserved = torch.cuda.memory_allocated(), torch.cuda.memory_reserved()
            if reserved > ratio * max(alloc, 256 * 1024 * 1024):
                torch.cuda.empty_cache()
    except Exception:
        pass


def _log_vram(n: int) -> None:
    try:
        import torch
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            sys.stderr.write(f"[vram] synth#{n} alloc={torch.cuda.memory_allocated() / 1e9:.2f} reserved={torch.cuda.memory_reserved() / 1e9:.2f} "
                             f"peak={torch.cuda.max_memory_allocated() / 1e9:.2f} device_free={free / 1e9:.2f}/{total / 1e9:.1f} GB\n")
            sys.stderr.flush()
    except Exception:
        pass


def _redirect_stdout():
    """Models print progress bars to stdout; our protocol owns stdout, so send everything else to stderr."""
    real = sys.stdout
    sys.stdout = sys.stderr
    return real


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--engine", required=True)
    p.add_argument("--scratch", required=True)
    p.add_argument("--device", default=None)
    p.add_argument("--kw", nargs="*", default=[], help="adapter kwargs k=v")
    p.add_argument("--parent-pid", type=int, default=0, help="exit when this process is gone (no orphaned GPU workers)")
    a = p.parse_args(argv)
    if a.parent_pid:
        _watch_parent(a.parent_pid)
    os.environ.setdefault("TQDM_DISABLE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    out = _redirect_stdout()
    try:
        # torch ships the CUDA runtime DLLs ctranslate2/onnx may need (Windows)
        import torch
        lib = os.path.join(os.path.dirname(torch.__file__), "lib")
        if os.name == "nt" and os.path.isdir(lib):
            os.add_dll_directory(lib)
    except Exception:
        pass
    from . import protocol as P
    from .adapters import load_adapter

    kw = {}
    for item in a.kw:
        k, _, v = item.partition("=")
        kw[k] = v
    scratch = Path(a.scratch)
    scratch.mkdir(parents=True, exist_ok=True)
    adapter = load_adapter(a.engine, device=a.device, **kw)
    P.send({"id": None, "ok": True, "event": P.READY, "pid": os.getpid(), "engine": a.engine}, out)
    counters = {"synth": 0, "errors": 0, "audio_seconds": 0.0, "busy_seconds": 0.0}

    while True:
        try:
            req = P.recv()
        except Exception as e:  # malformed line: report and keep serving
            P.send({"id": None, "ok": False, "error": f"bad request: {e}", "kind": "bad_input"}, out)
            continue
        if req is None:
            return 0
        if not req:
            continue
        op, rid = req.get("op"), req.get("id")
        t0 = time.perf_counter()
        try:
            if op == "quit":
                P.send({"id": rid, "ok": True}, out)
                return 0
            if op == "load":
                adapter.load()
                P.send({"id": rid, "ok": True, "sr": adapter.sr, "seconds": round(time.perf_counter() - t0, 2),
                        "caps": {"needs_reference": adapter.needs_reference, "needs_ref_text": adapter.needs_ref_text, "supports_tags": adapter.supports_tags,
                                 "supports_design": adapter.supports_design, "supports_instruct": adapter.supports_instruct, "passage_chars": adapter.passage_chars, "spell_acronyms": adapter.spell_acronyms, "streaming": adapter.supports_streaming, "license": adapter.license,
                                 "commercial": adapter.commercial, "vram_gb": adapter.vram_gb}, **adapter.stats()}, out)
            elif op == "voice":
                adapter.prepare_voice(req["voice_id"], req.get("ref"), req.get("ref_text"), req.get("desc"))
                if req.get("warmup"):
                    adapter.warmup()
                P.send({"id": rid, "ok": True, "voice_id": req["voice_id"], "seconds": round(time.perf_counter() - t0, 2)}, out)
            elif op == "synth":
                audio = adapter.synth(req["text"], req.get("voice_id"), req.get("params") or {}, int(req.get("seed", 0)))
                _trim_cuda_cache()
                if os.environ.get("FIREVOICE_VRAM_LOG"):
                    _log_vram(counters["synth"])
                dst = scratch / f"{rid}.npy"
                tmp = dst.with_suffix(".tmp.npy")
                np.save(tmp, audio)
                os.replace(tmp, dst)
                dt = time.perf_counter() - t0
                counters["synth"] += 1
                counters["audio_seconds"] += len(audio) / adapter.sr
                counters["busy_seconds"] += dt
                P.send({"id": rid, "ok": True, "path": str(dst), "sr": adapter.sr, "n": int(len(audio)), "seconds": round(dt, 3)}, out)
            elif op == "synth_stream":
                # pieces go out as {"event": "part", path} as soon as ~0.25 s is ready; the reply carries the whole take
                pieces, pending, k = [], [], 0
                min_n = int(adapter.sr * 0.25)

                def flush():
                    nonlocal pending, k
                    if not pending:
                        return
                    part = np.concatenate(pending)
                    pending = []
                    p = scratch / f"{rid}.part{k}.npy"
                    tmp = p.with_suffix(".tmp.npy")
                    np.save(tmp, part)
                    os.replace(tmp, p)
                    k += 1
                    P.send({"id": rid, "ok": True, "event": "part", "path": str(p), "n": int(len(part))}, out)
                for piece in adapter.synth_stream(req["text"], req.get("voice_id"), req.get("params") or {}, int(req.get("seed", 0))):
                    pieces.append(piece)
                    pending.append(piece)
                    if sum(len(x) for x in pending) >= min_n:
                        flush()
                flush()
                audio = np.concatenate(pieces) if pieces else np.zeros(0, np.float32)
                _trim_cuda_cache()
                dst = scratch / f"{rid}.npy"
                tmp = dst.with_suffix(".tmp.npy")
                np.save(tmp, audio)
                os.replace(tmp, dst)
                dt = time.perf_counter() - t0
                counters["synth"] += 1
                counters["audio_seconds"] += len(audio) / adapter.sr
                counters["busy_seconds"] += dt
                P.send({"id": rid, "ok": True, "path": str(dst), "sr": adapter.sr, "n": int(len(audio)), "seconds": round(dt, 3), "parts": k}, out)
            elif op == "stats":
                P.send({"id": rid, "ok": True, **adapter.stats(), **counters}, out)
            else:
                P.send({"id": rid, "ok": False, "error": f"unknown op {op!r}", "kind": "bad_input"}, out)
        except BaseException as e:  # noqa: BLE001  the worker must never die silently
            kind = P.classify_error(e)
            counters["errors"] += 1
            if kind == "oom":
                try:
                    import torch
                    torch.cuda.empty_cache()
                except Exception:
                    pass
            P.send({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}", "kind": kind, "trace": traceback.format_exc()[-2000:]}, out)
            if isinstance(e, (KeyboardInterrupt, SystemExit)):
                return 1


if __name__ == "__main__":
    raise SystemExit(main())
