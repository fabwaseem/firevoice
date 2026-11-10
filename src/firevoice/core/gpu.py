"""Device-wide GPU memory. On Windows (WDDM) torch.cuda.mem_get_info() inside one process can report several GB more
free memory than the card really has (other processes' allocations are not fully visible), so decisions about
loading engines use nvidia-smi first and torch only as a fallback."""
from __future__ import annotations

import shutil
import subprocess
from typing import Optional


def free_vram_gb(index: int = 0) -> Optional[float]:
    smi = shutil.which("nvidia-smi")
    if smi:
        try:
            out = subprocess.run([smi, f"--id={index}", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=5)
            if out.returncode == 0 and out.stdout.strip():
                return float(out.stdout.strip().splitlines()[0]) / 1024.0
        except Exception:
            pass
    try:
        import torch
        if torch.cuda.is_available():
            free, _ = torch.cuda.mem_get_info(index)
            return free / 1e9
    except Exception:
        pass
    return None


_GPU_CACHE: dict = {}


def gpu_info(index: int = 0) -> dict:
    """GPU name, memory and load. Read at most every 2 s: status bars ask often and nvidia-smi takes ~100 ms."""
    import time as _t
    hit = _GPU_CACHE.get(index)
    if hit and _t.monotonic() - hit[0] < 2.0:
        return dict(hit[1])
    info = _gpu_info(index)
    _GPU_CACHE[index] = (_t.monotonic(), info)
    return dict(info)


def _gpu_info(index: int = 0) -> dict:
    smi = shutil.which("nvidia-smi")
    if smi:
        try:
            out = subprocess.run([smi, f"--id={index}", "--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu",
                                  "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5)
            if out.returncode == 0 and out.stdout.strip():
                name, total, used, free, util, temp = [x.strip() for x in out.stdout.strip().splitlines()[0].split(",")]
                return {"name": name, "vram_total_gb": round(float(total) / 1024, 2), "vram_used_gb": round(float(used) / 1024, 2),
                        "vram_free_gb": round(float(free) / 1024, 2), "utilization": int(float(util)), "temperature_c": int(float(temp))}
        except Exception:
            pass
    try:
        import torch
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info(index)
            return {"name": torch.cuda.get_device_name(index), "vram_total_gb": round(total / 1e9, 2), "vram_free_gb": round(free / 1e9, 2)}
    except Exception:
        pass
    return {}
