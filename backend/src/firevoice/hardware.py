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
ENV_GB_CPU = 3.0         # the same with the CPU build of torch (no NVIDIA card)

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


_STATIC: dict = {}


def _run_text(cmd: list, timeout: float = 6.0) -> str:
    import subprocess
    try:
        flags = 0x08000000 if os.name == "nt" else 0        # CREATE_NO_WINDOW: no console flashing up in the app
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, creationflags=flags)
        return r.stdout if r.returncode == 0 else ""
    except Exception:
        return ""


def vendor_of(name: Optional[str]) -> Optional[str]:
    n = (name or "").lower()
    if re.search(r"microsoft basic|remote display|virtual|vmware|parallels|qxl|virtio|llvmpipe", n):
        return "virtual"
    if re.search(r"nvidia|geforce|quadro|\brtx\b|\bgtx\b|tesla", n):
        return "nvidia"
    if re.search(r"\bamd\b|radeon|\bati\b|firepro|instinct", n):
        return "amd"
    if re.search(r"intel|\barc\b|iris|uhd graphics", n):
        return "intel"
    return None


def list_gpus() -> list[dict]:
    """Every graphics adapter the operating system reports: [{name, vendor, vram_gb}]. Read once per run."""
    if "gpus" in _STATIC:
        return [dict(g) for g in _STATIC["gpus"]]
    out: list[dict] = []
    try:
        if os.name == "nt":
            txt = _run_text(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                             "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + '|' + $_.AdapterRAM }"])
            for line in txt.splitlines():
                name, _, ram = line.strip().partition("|")
                if name:
                    # AdapterRAM is a 32-bit number, so a card with 4 GB or more reports at most 4 GB: only a floor
                    out.append({"name": name, "vendor": vendor_of(name), "vram_gb": round(int(ram) / 1e9, 1) if ram.isdigit() and int(ram) > 0 else None})
        elif sys.platform.startswith("linux"):
            for line in _run_text(["lspci", "-mm"]).splitlines():
                if re.search(r'"(VGA compatible controller|3D controller|Display controller)"', line):
                    parts = re.findall(r'"([^"]*)"', line)
                    name = " ".join(parts[2:4]).strip() if len(parts) >= 4 else line
                    out.append({"name": name, "vendor": vendor_of(name), "vram_gb": None})
    except Exception:
        out = []
    _STATIC["gpus"] = out
    return [dict(g) for g in out]


def detect(gpu: Optional[dict] = None) -> dict:
    """What this computer is: {os, torch, accelerator, gpu, gpu_vendor, vram_gb, vram_free_gb, speed, other_gpus, ram_gb,
    cpu_cores, disk_free_gb, disk_path}.

    accelerator is what the voice engines can use: "cuda" (an NVIDIA card with its driver), "rocm" (a torch built for AMD,
    which FireVoice does not install itself) or "none" (they run on the processor). other_gpus lists the adapters that
    were found but cannot be used, so a message can name them."""
    from . import paths
    forced_cpu = os.environ.get("FIREVOICE_ACCELERATOR", "").lower() == "cpu"     # a broken driver, or a test: ignore the card
    if forced_cpu:
        gpu = {}
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"       # the engines' own processes inherit this
    elif gpu is None:
        from .core.gpu import gpu_info
        gpu = gpu_info() or {}
    where = paths.engines_dir()
    import importlib.util
    has_torch = importlib.util.find_spec("torch") is not None
    accel = "cuda" if gpu.get("name") else "none"
    if accel == "none" and has_torch:
        try:
            import torch
            if torch.cuda.is_available():
                accel = "rocm" if getattr(torch.version, "hip", None) else "cuda"
                gpu = {**gpu, "name": torch.cuda.get_device_name(0), "vram_total_gb": round(torch.cuda.mem_get_info(0)[1] / 1e9, 2)}
        except Exception:
            pass
    name, vram = gpu.get("name"), gpu.get("vram_total_gb")
    others = [g for g in list_gpus() if g.get("vendor") != "virtual" and not (name and g["name"] and g["name"].lower() in name.lower())]
    if accel != "none":
        others = [g for g in others if g.get("vendor") != vendor_of(name)]
    system = "macos" if sys.platform == "darwin" else ("windows" if os.name == "nt" else "linux")
    return {"os": system, "torch": has_torch, "accelerator": accel, "gpu": name, "gpu_vendor": vendor_of(name), "vram_gb": vram,
            "vram_free_gb": gpu.get("vram_free_gb"), "speed": gpu_speed(name, vram) if name else None, "other_gpus": others,
            "ram_gb": _ram_gb(), "cpu_cores": os.cpu_count(), "disk_free_gb": free_gb(where), "disk_path": str(where)}


def short_gpu(name: Optional[str]) -> str:
    n = re.sub(r"\((R|TM)\)", "", name or "", flags=re.I)
    return re.sub(r"\s+", " ", re.sub(r"^(nvidia )?(geforce )?", "", n.strip(), flags=re.I)).strip() or "graphics card"


# What each engine needs to run. gpu: "required" (no usable speed without an NVIDIA card), "preferred" (runs on the processor,
# slower) or "none". vram: graphics memory in GB (the catalog's measurement when it has one); ram: system memory in GB;
# cpu_rtf: seconds to make one second of speech on the processor, whole render included (the speech check too), measured on
# a 16-thread desktop processor (Ryzen 7 9800X3D) with the graphics card hidden; None: not practical there (Flicker took
# 17 s per second of speech, Flare's workers never finished a line). Unmeasured ones are marked; they are estimates.
# cuda_only: needs CUDA itself (triton kernels), not just a fast card; os: the systems it is known to work on.
REQUIREMENTS: dict[str, dict] = {
    "null": {"gpu": "none", "ram": 1, "cpu_rtf": 0.0},
    "kokoro": {"gpu": "none", "ram": 4, "cpu_rtf": 0.25},           # measured: 0.16 alone, 0.25 with the speech check
    "chatterbox-turbo": {"gpu": "preferred", "ram": 8, "cpu_rtf": 2.1},   # measured
    "chatterbox": {"gpu": "preferred", "ram": 8, "cpu_rtf": 3.4},          # measured
    "chatterbox-vc": {"gpu": "preferred", "ram": 8, "cpu_rtf": 3.0},       # estimate (the same speech decoder as Torch)
    "f5": {"gpu": "required", "ram": 8},                                   # measured 17x slower than real time: not offered
    "omnivoice": {"gpu": "required", "ram": 8},                            # never finished a line on the processor
    "separator": {"gpu": "preferred", "ram": 6, "cpu_rtf": 1.5},           # estimate
    "musicgen": {"gpu": "preferred", "ram": 8, "cpu_rtf": 3.0},            # estimate
    "audioldm2": {"gpu": "required", "ram": 12},
    "ming": {"gpu": "required", "ram": 12},
    "qwen3-tts": {"gpu": "required", "ram": 16},
    "qwen3-tts-design": {"gpu": "required", "ram": 16},
    "voxcpm2": {"gpu": "required", "ram": 16, "cuda_only": True},
    "dots": {"gpu": "required", "ram": 16},
    "indextts2": {"gpu": "required", "ram": 16},
    "indextts25": {"gpu": "required", "ram": 16},
    "breeze": {"gpu": "required", "ram": 16},
    "maya1": {"gpu": "required", "ram": 16},
    "moss": {"gpu": "required", "ram": 24},
}
CPU_BASE_THREADS = 16    # the processor the cpu_rtf numbers were measured on
CPU_PENALTY = 1.3        # most processors are slower per thread than that desktop one
SLOW_RTF = 1.0           # slower than real time: it works, but a script takes longer to make than to hear


def _first_gpu(hw: dict) -> dict:
    """The adapter worth naming in a message: an NVIDIA card first (its driver may just be missing), then AMD, then Intel."""
    order = {"nvidia": 0, "amd": 1, "intel": 2}
    return sorted(hw.get("other_gpus") or [{}], key=lambda g: order.get(g.get("vendor"), 3))[0]


def _fmt_gb(x: Optional[float]) -> str:
    return f"{x:.0f} GB" if x is not None and abs(x - round(x)) < 0.05 else f"{x:.1f} GB"


def compat(name: str, hw: dict, vram_need: Optional[float] = None) -> dict:
    """Whether engine `name` can run on this computer: {status, summary, reasons, est_rtf, device}.

    status "ok"       runs well here;
           "slow"     runs, but slower than real time (on the processor, or a weak card): fine for short lines;
           "no"       cannot run here: `summary` says what is missing, in words a person can check.
    device is where it would run: "gpu" or "cpu"."""
    req = REQUIREMENTS.get(name) or {"gpu": "preferred", "ram": 8, "cpu_rtf": 3.0}
    accel, vram, ram = hw.get("accelerator") or ("cuda" if hw.get("gpu") else "none"), hw.get("vram_gb"), hw.get("ram_gb")
    speed = hw.get("speed")
    need = float(vram_need if vram_need is not None else 4.0)
    reasons: list[str] = []
    unsupported = req.get("os")
    if unsupported and hw.get("os") not in unsupported:
        why = f"It only runs on {' and '.join(s.title() for s in unsupported)}."
        return {"status": "no", "summary": why, "reasons": [why], "est_rtf": None, "device": None}
    if ram is not None and ram < req.get("ram", 0) * 0.75:
        why = f"It needs about {_fmt_gb(req['ram'])} of system memory and this computer has {_fmt_gb(ram)}."
        return {"status": "no", "summary": why, "reasons": [why], "est_rtf": None, "device": None}
    gpu_ok = accel in ("cuda", "rocm") and (not req.get("cuda_only") or accel == "cuda")
    if gpu_ok and vram is not None and need + 0.5 > vram:
        reasons.append(f"It needs about {_fmt_gb(need)} of graphics memory and your {short_gpu(hw.get('gpu'))} has {_fmt_gb(vram)}.")
        gpu_ok = False
    if gpu_ok:
        rtf = None
        from .core import brands
        try:
            t = (brands.describe(name, need) or {}).get("tier") or {}
            rtf = round(t["rtf"] / speed, 2) if (t.get("rtf") and speed) else None
        except Exception:
            rtf = None
        if rtf is not None and rtf > SLOW_RTF:
            return {"status": "slow", "summary": f"Runs on your {short_gpu(hw.get('gpu'))}, slower than real time.", "reasons": [], "est_rtf": rtf, "device": "gpu"}
        return {"status": "ok", "summary": "", "reasons": [], "est_rtf": rtf, "device": "gpu"}
    # no usable graphics card (or not enough of one): the processor
    cpu = req.get("cpu_rtf")
    if req.get("gpu") == "required" or cpu is None:
        if not reasons:
            if accel == "none" and hw.get("other_gpus"):
                g = _first_gpu(hw)
                if g.get("vendor") == "nvidia":
                    reasons.append(f"Your {short_gpu(g.get('name'))} was found, but its driver is not working. Install the latest NVIDIA driver, restart the computer, and this engine will be available.")
                else:
                    reasons.append(f"It needs an NVIDIA graphics card with about {_fmt_gb(need)} of memory. Your {short_gpu(g.get('name'))} cannot run FireVoice's engines yet.")
            elif accel == "none":
                reasons.append(f"It needs an NVIDIA graphics card with about {_fmt_gb(need)} of memory, and none was found.")
            else:
                reasons.append(f"It needs a faster graphics card than this one.")
        elif req.get("gpu") == "required":
            reasons.append("It cannot run on the processor alone.")
        return {"status": "no", "summary": " ".join(reasons), "reasons": reasons, "est_rtf": None, "device": None}
    cores = hw.get("cpu_cores") or 4
    est = round(cpu * CPU_PENALTY * (CPU_BASE_THREADS / max(2, min(cores, 32))) ** 0.7, 2)
    note = (" ".join(reasons) + " ") if reasons else ""
    if est > SLOW_RTF:
        return {"status": "slow", "summary": f"{note}Runs on your processor, about {est:.0f}x slower than real time: fine for short lines.".strip(),
                "reasons": reasons, "est_rtf": est, "device": "cpu"}
    return {"status": "ok", "summary": f"{note}Runs on your processor.".strip(), "reasons": reasons, "est_rtf": est, "device": "cpu"}


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
    # the runtime still has to be installed: that room is spoken for (the CPU build of torch is far smaller)
    reserve = 0.0 if hw.get("torch", True) else (ENV_GB if hw.get("gpu") else ENV_GB_CPU)
    by_name = {e["name"]: e for e in engines}
    scored = []
    for e in candidates(engines):
        tier = e["tier"]
        need = float(tier.get("vram_gb") or e.get("vram_gb") or 4.0)
        rtf = tier.get("rtf")
        est = round(rtf / speed, 2) if (rtf and speed) else None
        fits_gpu = bool(gpu and vram and need + HEADROOM_GB <= vram and compat(e["name"], hw, need)["status"] != "no")
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
        og = _first_gpu(hw)
        other = og.get("name")
        best["reason"] = (((f"Your {short_gpu(other)} was found, but its driver is not working, so {best['title']} is the pick for now: it runs on your processor. "
                            "Install the latest NVIDIA driver to unlock the faster engines."
                            if og.get("vendor") == "nvidia" else
                            f"Your {short_gpu(other)} cannot run FireVoice's engines yet, so {best['title']} is the pick: it runs on your processor, with ready-made voices.")
                           if other else
                           f"No NVIDIA graphics card was found, so {best['title']} is the pick: it is small enough to run on your processor, with ready-made voices.")
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
