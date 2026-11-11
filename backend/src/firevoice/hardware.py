"""What this computer can run, and which engine suits it: fast enough, and the best quality that is.

`detect()` reads the graphics card (name, memory), the system memory and the free disk space. `choose()` then scores every
engine that can be installed on its own and that clones voices, using the catalog's own measurements:

* quality   the engine's tier (Studio > Pro > Standard) from the bake-off;
* speed     its measured real-time factor on an RTX 5080, scaled to this card by a relative speed (see GPU_SPEED), and it
            has to be comfortably faster than real time (RTF_LIMIT), or a script would take longer to make than to hear;
* memory    its graphics memory need plus headroom for Windows itself has to fit the card;
* disk      what installing it adds has to fit the free space.

Of the engines that pass, the highest quality wins, the faster one breaking a tie. With no NVIDIA card (or nothing
that passes) the small CPU-capable engine is the answer. `reason` says why, in words a person can check against their own
computer.
"""
from __future__ import annotations

import os
import re
import shutil
import sys
from pathlib import Path
from typing import Optional

QUALITY = {"Studio": 3, "Pro": 2, "Standard": 1}
RTF_LIMIT = 0.7          # slower than this (seconds to make one second of speech) and the engine is not offered first
HEADROOM_GB = 1.0        # graphics memory kept free for Windows and other programs
FALLBACK = "kokoro"      # small enough for any computer; ready-made voices
ENV_GB = 9.5             # what the runtime's torch and libraries take on disk while they are not installed yet

# Relative speed against the RTX 5080 the catalog's speeds were measured on (1.0). First match wins; most specific first.
GPU_SPEED: list[tuple[str, float]] = [
    (r"rtx 5090", 1.7), (r"rtx 5080", 1.0), (r"rtx 5070 ti", 0.85), (r"rtx 5070", 0.7), (r"rtx 5060 ti", 0.55), (r"rtx 5060", 0.45),
    (r"rtx 4090", 1.35), (r"rtx 4080", 0.95), (r"rtx 4070 ti", 0.8), (r"rtx 4070 super", 0.7), (r"rtx 4070", 0.62), (r"rtx 4060 ti", 0.45),
    (r"rtx 4060", 0.38), (r"rtx 4050", 0.3),
    (r"rtx 3090", 0.75), (r"rtx 3080 ti", 0.7), (r"rtx 3080", 0.65), (r"rtx 3070", 0.5), (r"rtx 3060 ti", 0.42), (r"rtx 3060", 0.33),
    (r"rtx 3050", 0.2),
    (r"rtx 2080", 0.4), (r"rtx 2070", 0.32), (r"rtx 2060", 0.26),
    (r"gtx 1080", 0.27), (r"gtx 1070", 0.22), (r"gtx 1660", 0.17), (r"gtx 1650", 0.14), (r"gtx 1060", 0.15),
    (r"h100", 3.0), (r"a100", 1.6), (r"l40", 1.5), (r"rtx 6000 ada", 1.5), (r"a6000", 1.0), (r"a5000", 0.7), (r"a4000", 0.5),
    (r"a10\b", 0.7), (r"\bl4\b", 0.5), (r"\bt4\b", 0.22),
]


def gpu_speed(name: Optional[str], vram_gb: Optional[float]) -> float:
    """How fast this card is relative to an RTX 5080: from its name when known, else guessed from its memory."""
    n = (name or "").lower()
    f = next((s for pat, s in GPU_SPEED if re.search(pat, n)), None)
    if f is None:
        f = min(1.5, max(0.2, 0.2 + (vram_gb or 4) / 20))     # unknown card: more memory usually means a bigger chip
    if re.search(r"laptop|mobile|max-q", n):
        f *= 0.75
    return round(f, 2)


def _ram_gb() -> Optional[float]:
    try:
        if os.name == "nt":
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong), ("avail", ctypes.c_ulonglong),
                            ("tpf", ctypes.c_ulonglong), ("apf", ctypes.c_ulonglong), ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong),
                            ("ext", ctypes.c_ulonglong)]
            m = MS()
            m.length = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return round(m.total / 1e9, 1)
        return round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9, 1)
    except Exception:
        return None


def free_gb(path: Path) -> Optional[float]:
    """Free space, in GB, on the drive that holds `path` (which need not exist yet)."""
    try:
        p = Path(path)
        while not p.exists() and p.parent != p:
            p = p.parent
        return round(shutil.disk_usage(p).free / 1e9, 1)
    except Exception:
        return None


def detect(gpu: Optional[dict] = None) -> dict:
    """{gpu, vram_gb, vram_free_gb, speed, ram_gb, cpu_cores, disk_free_gb, disk_path}."""
    from . import paths
    if gpu is None:
        from .core.gpu import gpu_info
        gpu = gpu_info() or {}
    vram = gpu.get("vram_total_gb")
    where = paths.engines_dir()
    import importlib.util
    return {"torch": importlib.util.find_spec("torch") is not None, "gpu": gpu.get("name"), "vram_gb": vram, "vram_free_gb": gpu.get("vram_free_gb"), "speed": gpu_speed(gpu.get("name"), vram) if gpu.get("name") else None,
            "ram_gb": _ram_gb(), "cpu_cores": os.cpu_count(), "disk_free_gb": free_gb(where), "disk_path": str(where)}


def short_gpu(name: Optional[str]) -> str:
    return re.sub(r"^(nvidia )?(geforce )?", "", name or "", flags=re.I).strip() or "graphics card"


def candidates(engines: list[dict]) -> list[dict]:
    """The engines worth offering first: ones that install on their own (no git checkout), make speech and clone voices."""
    from . import installer
    out = []
    for e in engines:
        m = installer.MANIFESTS.get(e["name"])
        if not m or not m.auto or m.git or m.repo_code:
            continue
        tier = e.get("tier") or {}
        if not tier.get("quality") or e.get("task", "tts") != "tts":
            continue
        out.append(e)
    return out


def _extra_disk_gb(e: dict) -> float:
    """Roughly what installing this engine adds (its own environment and weights), beyond the shared runtime."""
    from . import installer
    m = installer.MANIFESTS.get(e["name"])
    own = 0.0 if (m is None or m.venv is None) else (m.venv_gb if m.torch and m.torch != "2.11.0" else min(m.venv_gb, 2.0))
    return own + float(e.get("weights_gb") or 3.0)


def choose(hw: dict, engines: list[dict]) -> tuple[Optional[dict], list[dict]]:
    """(best engine, the next best ones) for this hardware. Each carries `reason`, `est_rtf` and `fit`."""
    gpu, vram, speed = hw.get("gpu"), hw.get("vram_gb"), hw.get("speed")
    disk = hw.get("disk_free_gb")
    reserve = 0.0 if hw.get("torch", True) else ENV_GB      # the runtime still has to be installed: that room is spoken for
    by_name = {e["name"]: e for e in engines}
    scored = []
    for e in candidates(engines):
        tier = e["tier"]
        need = float(tier.get("vram_gb") or e.get("vram_gb") or 4.0)
        rtf = tier.get("rtf")
        est = round(rtf / speed, 2) if (rtf and speed) else None
        fits_gpu = bool(gpu and vram and need + HEADROOM_GB <= vram)
        fast = est is not None and est <= RTF_LIMIT
        room = disk is None or _extra_disk_gb(e) + 2.0 + reserve <= disk
        e2 = {**e, "est_rtf": est, "fit": {"memory": fits_gpu, "speed": fast, "disk": room}}
        if e.get("clone", True) and fits_gpu and fast and room:
            scored.append((QUALITY.get(tier["quality"], 0), -(est or 9), e2))
    scored.sort(key=lambda t: (t[0], t[1]), reverse=True)

    best = scored[0][2] if scored else None
    if best:
        t = best["tier"]
        x = (1 / best["est_rtf"]) if best.get("est_rtf") else None
        pace = f", about {x:.0f}x faster than real time" if x and x >= 1.5 else ", fast enough to keep up with your script"
        best["reason"] = (f"{best['title']} is the best match for your {short_gpu(gpu)} ({vram:.0f} GB of graphics memory): "
                          f"{t['quality']} quality{pace}.")
    else:
        fb = by_name.get(FALLBACK)
        if fb is None:
            return None, []
        best = {**fb, "est_rtf": None, "fit": {"memory": True, "speed": True, "disk": True}}
        best["reason"] = (f"No NVIDIA graphics card was found, so {best['title']} is the pick: it is small enough to run without one, with ready-made voices."
                          if not gpu else
                          f"Your {short_gpu(gpu)} has limited memory or speed, so {best['title']} is the pick: it needs about 1 GB and makes speech in an instant.")
    rest = [e for _, _, e in scored if e["name"] != best["name"]][:2]
    for e in rest:
        e["reason"] = f"{e['title']} also runs well here: {e['tier']['quality']} quality."
    fb = by_name.get(FALLBACK)
    if fb and fb["name"] != best["name"] and all(r["name"] != fb["name"] for r in rest):
        rest.append({**fb, "est_rtf": None, "fit": {"memory": True, "speed": True, "disk": True},
                     "reason": f"{fb['title']} is tiny and very fast, with ready-made voices."})
    return best, rest[:3]
