"""Engine installer: build an engine's venv and fetch its weights from a pinned manifest.

Every heavy engine runs in its own venv (their torch and transformers pins conflict), under paths.engines_dir().
An install is a background job with these steps:

1. `uv venv --python 3.12 <engines>/<venv>` (uv fetches the Python if needed), skipped when the venv already works;
2. torch and torchaudio from the CUDA 12.8 index (RTX 50-series needs cu128; PyPI's Windows torch is CPU-only);
3. the engine's packages, pinned to the versions FireVoice was tested with;
4. the model weights into <weights>/<name>/ (huggingface_hub, resumable);
5. an import check inside the new venv.

All venvs share uv's cache (UV_CACHE_DIR moves it) and uv hardlinks from it, so torch is stored once per version on
that drive instead of once per engine (uv copies instead when the cache is on another drive). Engines whose code lives in a cloned repository (IndexTTS-2, Breeze) are not installed automatically: running
code from a cloned repo is a decision for the user, so their manifest carries the manual steps instead.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Optional

from . import paths

TORCH_INDEX = "https://download.pytorch.org/whl/cu128"
PYTHON = "3.12"


@dataclass
class Manifest:
    engine: str
    venv: Optional[str]                         # None: runs in the backend's own environment
    torch: Optional[str] = None                 # "2.11.0": torch==, torchaudio== from the CUDA index
    torchaudio: bool = True
    packages: list = field(default_factory=list)
    windows_extra: list = field(default_factory=list)   # speed-ups that only exist on Windows (triton-windows)
    weights: list = field(default_factory=list)          # [(hub repo, folder under weights/)]
    check: Optional[str] = None                 # module that must import in the venv
    venv_gb: float = 5.0                        # size of a fresh venv without a shared cache
    manual: Optional[str] = None                # why it is not automatic, and what to do instead
    notes: str = ""

    @property
    def auto(self) -> bool:
        return self.manual is None and self.venv is not None


_T211 = "2.11.0"
MANIFESTS: dict[str, Manifest] = {m.engine: m for m in [
    Manifest("voxcpm2", "voxcpm", _T211, packages=["voxcpm==2.0.3", "transformers==5.22.2", "soundfile", "numpy"],
             windows_extra=["triton-windows==3.7.1.post27"], weights=[("openbmb/VoxCPM2", "voxcpm2")], check="voxcpm", venv_gb=5.4,
             notes="triton-windows lets VoxCPM2 compile itself (about 3x faster after a 2 minute warm-up)"),
    Manifest("qwen3-tts", "qwen", "2.9.1", packages=["qwen-tts==0.1.1", "transformers==4.57.3", "accelerate==1.12.0", "soundfile"],
             weights=[("Qwen/Qwen3-TTS-12Hz-1.7B-Base", "qwen3-tts-1.7b-base")], check="qwen_tts"),
    Manifest("qwen3-tts-design", "qwen", "2.9.1", packages=["qwen-tts==0.1.1", "transformers==4.57.3", "accelerate==1.12.0", "soundfile"],
             weights=[("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "qwen3-tts-1.7b-voicedesign")], check="qwen_tts",
             notes="shares the qwen venv with qwen3-tts"),
    Manifest("dots", "dots", _T211, packages=["dots-tts==0.3.1", "transformers==5.22.2", "soundfile"],
             weights=[("dots-studio/dots.tts-soar", "dots-tts-soar")], check="dots_tts"),
    Manifest("maya1", "maya1", _T211, packages=["transformers==5.22.2", "accelerate==1.15.0", "snac==1.2.1", "soundfile"],
             weights=[("maya-research/maya1", "maya1")], check="snac"),
    Manifest("omnivoice", "omnivoice", _T211, packages=["omnivoice==0.2.1", "accelerate==1.15.0", "soundfile"],
             weights=[("k2-fsa/OmniVoice", "omnivoice")], check="omnivoice"),
    Manifest("f5", "f5", "2.8.0", packages=["f5-tts==1.1.22", "soundfile"], check="f5_tts",
             notes="weights download on first load"),
    Manifest("kokoro", "kokoro", _T211, torchaudio=False, packages=["kokoro==0.9.4", "misaki==0.9.4", "soundfile",
             # misaki's English G2P loads this spaCy model by name
             "en-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"], check="kokoro",
             venv_gb=3.5, notes="weights (about 330 MB) download on first load"),
    Manifest("audioldm2", "sfx", _T211, packages=["diffusers==0.35.2", "transformers==4.57.3", "accelerate==1.12.0", "scipy", "soundfile"],
             weights=[("cvssp/audioldm2", "audioldm2")], check="diffusers", notes="sound effects; shares the sfx venv with musicgen"),
    Manifest("musicgen", "sfx", _T211, packages=["diffusers==0.35.2", "transformers==4.57.3", "accelerate==1.12.0", "scipy", "soundfile"],
             weights=[("facebook/musicgen-small", "musicgen-small")], check="transformers", notes="music beds; shares the sfx venv with audioldm2"),
    Manifest("chatterbox-turbo", None, manual="runs inside the backend's own environment: install the backend with the "
             "`gpu` extra (pip install \"firevoice[gpu]\"); the desktop app's bundled backend includes it"),
    Manifest("chatterbox", None, manual="runs inside the backend's own environment: install the backend with the `gpu` extra"),
    Manifest("chatterbox-vc", None, manual="runs inside the backend's own environment: install the backend with the `gpu` extra"),
    Manifest("indextts2", "indextts", "2.8.0", manual="IndexTTS-2 runs from a clone of its GitHub repository: clone "
             "https://github.com/index-tts/index-tts into <engines>/indextts-repo, build <engines>/indextts with its "
             "requirements, and download IndexTeam/IndexTTS-2 into <weights>/indextts-2",
             weights=[("IndexTeam/IndexTTS-2", "indextts-2")]),
    Manifest("breeze", "breeze", "2.9.1", manual="Breeze TTS 2 runs from a clone of its repository into <engines>/breeze-repo; "
             "its weights are research-only (BreezeBlue licence)", weights=[("MediaTek-Research/Breeze-TTS-2", "breeze-tts-2")]),
]}


def manifest(engine: str) -> Manifest:
    from .core.registry import get_engine
    name = get_engine(engine).name
    if name not in MANIFESTS:
        raise KeyError(f"no install manifest for {name!r}")
    return MANIFESTS[name]


def uv() -> Optional[str]:
    """uv: FIREVOICE_UV, FIREVOICE_HOME/bin, PATH, then the `uv` Python package next to this interpreter."""
    if os.environ.get("FIREVOICE_UV"):
        return os.environ["FIREVOICE_UV"]
    local = paths.home() / "bin" / f"uv{paths.EXE}"
    if local.exists():
        return str(local)
    if shutil.which("uv"):
        return shutil.which("uv")
    try:
        from uv import find_uv_bin  # the PyPI `uv` package ships the binary
        return find_uv_bin()
    except Exception:
        return None


def uv_env() -> dict:
    """uv keeps its own machine-wide cache (UV_CACHE_DIR moves it): every engine venv hardlinks from it, so a torch
    build already used by another venv is neither downloaded nor stored again."""
    env = dict(os.environ)
    env.setdefault("UV_LINK_MODE", "hardlink")
    env["PYTHONUTF8"] = "1"
    env.pop("VIRTUAL_ENV", None)
    return env


MARKER = ".firevoice-install.json"


def _wanted(m: Manifest) -> list:
    return sorted([f"torch=={m.torch}"] if m.torch else []) + sorted(m.packages + (m.windows_extra if os.name == "nt" else []))


def _marker(m: Manifest) -> Optional[dict]:
    try:
        import json
        return json.loads((paths.engines_dir() / m.venv / MARKER).read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_marker(m: Manifest, status: str) -> None:
    import json
    f = paths.engines_dir() / m.venv / MARKER
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"status": status, "engine": m.engine, "packages": _wanted(m), "time": time.time()}, indent=1), encoding="utf-8")


def venv_state(m: Manifest) -> str:
    """missing | building (an install stopped half way) | outdated (the manifest changed) | ok. A venv built by hand
    (no marker) counts as ok when its Python exists."""
    if m.venv is None or not paths.venv_python(m.venv).exists():
        return "missing"
    mk = _marker(m)
    if mk is None:
        return "ok"
    if mk.get("status") != "ok":
        return "building"
    if not set(_wanted(m)) <= set(mk.get("packages") or []):
        return "outdated"
    return "ok"


def venv_ok(m: Manifest) -> bool:
    return venv_state(m) == "ok"


def weights_ok(folder: str) -> bool:
    w = paths.weights(folder)
    return w.exists() and any(w.glob("*")) and not any(w.rglob("*.incomplete"))


def _repo_size(repo: str) -> Optional[int]:
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(repo, files_metadata=True)
        return sum((s.size or 0) for s in info.siblings or [])
    except Exception:
        return None


def plan(engine: str, sizes: bool = False) -> dict:
    """What an install would do, what is already there, and roughly how much it downloads."""
    m = manifest(engine)
    steps = []
    if m.venv:
        steps.append({"step": "venv", "what": f"Python {PYTHON} venv at {paths.engines_dir() / m.venv}", "done": venv_ok(m)})
        if m.torch:
            steps.append({"step": "torch", "what": f"torch {m.torch} (CUDA 12.8)", "done": venv_ok(m)})
        pk = m.packages + (m.windows_extra if os.name == "nt" else [])
        if pk:
            steps.append({"step": "packages", "what": ", ".join(pk), "done": venv_ok(m)})
    for repo, folder in m.weights:
        st = {"step": "weights", "what": f"{repo} -> {paths.weights(folder)}", "repo": repo, "folder": folder, "done": weights_ok(folder)}
        if sizes and not st["done"]:
            b = _repo_size(repo)
            st["gb"] = round(b / 1e9, 2) if b else None
        steps.append(st)
    if m.check:
        steps.append({"step": "check", "what": f"import {m.check}", "done": venv_ok(m)})
    todo_gb = sum(s.get("gb") or 0 for s in steps if s["step"] == "weights" and not s["done"])
    if m.venv and not venv_ok(m):
        todo_gb += m.venv_gb
    return {"engine": m.engine, "auto": m.auto, "manual": m.manual, "notes": m.notes, "venv": m.venv,
            "venv_state": venv_state(m) if m.venv else None,
            "installed": all(s["done"] for s in steps) if steps else m.venv is None,
            "steps": steps, "estimated_gb": round(todo_gb, 1) if sizes else None, "uv": uv(),
            "engines_dir": str(paths.engines_dir()), "weights_dir": str(paths.weights_dir())}


_VENV_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_LOCK = threading.Lock()


def _venv_lock(venv: str) -> threading.Lock:
    with _LOCKS_LOCK:
        return _VENV_LOCKS.setdefault(venv, threading.Lock())


class InstallError(RuntimeError):
    pass


class InstallCancelled(RuntimeError):
    pass


def _run(cmd: list[str], log, cancel: threading.Event, env: Optional[dict] = None, on_line: Optional[Callable[[str], None]] = None) -> None:
    log(f"$ {' '.join(cmd)}")
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                         env=env, creationflags=flags)
    tail: list[str] = []

    def pump():
        for line in p.stdout:
            line = line.rstrip()
            if line:
                log(line)
                tail.append(line)
                del tail[:-20]
                if on_line:
                    on_line(line)
    t = threading.Thread(target=pump, daemon=True)
    t.start()
    while p.poll() is None:
        if cancel.is_set():
            p.kill()
            p.wait()
            raise InstallCancelled("cancelled")
        time.sleep(0.3)
    t.join(timeout=5)
    if p.returncode != 0:
        raise InstallError(f"{Path(cmd[0]).name} exited with {p.returncode}: " + " | ".join(tail[-4:]))


# Weights go through the shared Hugging Face cache, then are hardlinked into the weights folder (copied when the cache is
# on another drive): a model already fetched by anything on this machine is not downloaded again.
_FETCH = """
import os, shutil, sys
from huggingface_hub import snapshot_download
src, dst = snapshot_download(sys.argv[1]), sys.argv[2]
for root, _dirs, files in os.walk(src):
    rel = os.path.relpath(root, src)
    os.makedirs(os.path.join(dst, rel), exist_ok=True)
    for f in files:
        s, d = os.path.realpath(os.path.join(root, f)), os.path.join(dst, rel, f)
        if os.path.exists(d) and os.path.getsize(d) == os.path.getsize(s):
            continue
        if os.path.exists(d):
            os.remove(d)
        try:
            os.link(s, d)
        except OSError:
            shutil.copy2(s, d)
print("weights in", dst)
"""


def _hub_cache_dir(repo: str) -> Optional[Path]:
    try:
        from huggingface_hub import constants
        return Path(constants.HF_HUB_CACHE) / ("models--" + repo.replace("/", "--"))
    except Exception:
        return None


def _dir_bytes(d: Path) -> int:
    return sum(f.stat().st_size for f in d.rglob("*") if f.is_file()) if d.exists() else 0


def install(engine: str, progress: Callable[[int, int, str], None], cancel: threading.Event, log_file: Optional[Path] = None,
            force: bool = False) -> dict:
    """Run the plan. `progress(step, steps, message)`; raises InstallCancelled or InstallError."""
    m = manifest(engine)
    if not m.auto:
        raise InstallError(m.manual or f"{m.engine} cannot be installed automatically")
    u = uv()
    if not u:
        raise InstallError("uv not found: install it (https://docs.astral.sh/uv/) or the backend's `server` extra, which includes it")
    fh = open(log_file, "a", encoding="utf-8") if log_file else None

    def log(line: str) -> None:
        if fh:
            fh.write(line + "\n")
            fh.flush()
    env = uv_env()
    py = paths.venv_python(m.venv)
    todo_weights = [(r, f) for r, f in m.weights if force or not weights_ok(f)]
    build = force or not venv_ok(m)
    steps = (3 if build else 0) + len(todo_weights) + 1
    k = 0
    t0 = time.time()
    try:
        with _venv_lock(m.venv):
            if build:
                paths.engines_dir().mkdir(parents=True, exist_ok=True)
                progress(k, steps, f"creating the {m.venv} venv (Python {PYTHON})")
                _run([u, "venv", "--allow-existing", "--python", PYTHON, str(paths.engines_dir() / m.venv)], log, cancel, env)
                _write_marker(m, "building")
                k += 1
                if m.torch:
                    progress(k, steps, f"installing torch {m.torch} for CUDA 12.8 (about 3 GB the first time)")
                    pk = [f"torch=={m.torch}"] + ([f"torchaudio=={m.torch}"] if m.torchaudio else [])
                    _run([u, "pip", "install", "--python", str(py), *pk, "--index-url", TORCH_INDEX], log, cancel, env)
                k += 1
                pk = m.packages + (m.windows_extra if os.name == "nt" else [])
                progress(k, steps, f"installing {', '.join(p.split('==')[0] for p in pk)}")
                # keep the CUDA torch: the engine packages must not swap it for PyPI's CPU build
                pin = [f"torch=={m.torch}"] + ([f"torchaudio=={m.torch}"] if m.torchaudio else []) if m.torch else []
                _run([u, "pip", "install", "--python", str(py), *pk, *pin, "--extra-index-url", TORCH_INDEX,
                      "--index-strategy", "unsafe-best-match"], log, cancel, env)
                k += 1
            for repo, folder in todo_weights:
                dest = paths.weights(folder)
                dest.mkdir(parents=True, exist_ok=True)
                total = _repo_size(repo)
                label = f"downloading {repo}" + (f" ({total / 1e9:.1f} GB)" if total else "")
                progress(k, steps, label)
                stop = threading.Event()
                cache = _hub_cache_dir(repo)
                start_bytes = _dir_bytes(cache) if cache else 0

                def watch(k=k, dest=dest, total=total, label=label, cache=cache, start_bytes=start_bytes):
                    while not stop.wait(2.0):
                        if total:
                            have = max(_dir_bytes(dest), (_dir_bytes(cache) - start_bytes) if cache else 0)
                            progress(k, steps, f"{label}: {min(100, round(100 * have / total))}%")
                w = threading.Thread(target=watch, daemon=True)
                w.start()
                try:
                    _run([sys.executable, "-c", _FETCH, repo, str(dest)], log, cancel, env)
                finally:
                    stop.set()
                k += 1
            if m.check:
                progress(k, steps, f"checking that {m.check} imports")
                _run([str(py), "-c", f"import {m.check}, torch; print('cuda', torch.cuda.is_available())"], log, cancel, env)
            if build:
                _write_marker(m, "ok")
            k += 1
    finally:
        if fh:
            fh.close()
    progress(steps, steps, "installed")
    return {"engine": m.engine, "venv": str(paths.engines_dir() / m.venv), "built_venv": build,
            "weights": [f for _, f in todo_weights], "seconds": round(time.time() - t0, 1)}


def uninstall(engine: str, weights: bool = False) -> dict:
    """Remove the engine's venv (shared venvs such as qwen go for every engine that uses them) and, optionally, its weights."""
    m = manifest(engine)
    if m.venv is None:
        raise InstallError(f"{m.engine} runs inside the backend's own environment and cannot be removed here")
    removed = []
    with _venv_lock(m.venv):
        d = paths.engines_dir() / m.venv
        if d.exists():
            shutil.rmtree(d)
            removed.append(str(d))
        if weights:
            for _, folder in m.weights:
                w = paths.weights(folder)
                if w.exists():
                    shutil.rmtree(w)
                    removed.append(str(w))
    shared = sorted(e for e, x in MANIFESTS.items() if x.venv == m.venv and e != m.engine)
    return {"engine": m.engine, "removed": removed, "also_affects": shared}


def manifests() -> list[dict]:
    return [{**asdict(m), "auto": m.auto} for m in MANIFESTS.values()]
