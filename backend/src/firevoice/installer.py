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
code from a cloned repo is a decision for the user. Engines that do run code from their own repository (a git checkout
pinned to a commit, or transformers `trust_remote_code` from pinned weights) say so with `repo_code`, and the plan and
the apps show it before installing.
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
TORCH_INDEX_CPU = "https://download.pytorch.org/whl/cpu"
PYTHON = "3.12"


def torch_index() -> str:
    """Where an engine's own environment gets torch: the CUDA build for an NVIDIA card, the small CPU build for any other
    computer (an AMD or Intel card, or none), which is a few hundred MB instead of several GB."""
    try:
        from . import hardware
        return TORCH_INDEX if hardware.detect()["accelerator"] != "none" else TORCH_INDEX_CPU
    except Exception:
        return TORCH_INDEX


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
    python: str = "3.12"
    git: Optional[tuple] = None                 # (url, full commit, folder under the engines dir): checked out, then installed
    editable: bool = False                      # install the checkout itself (pip -e), with its own dependencies
    requirements: Optional[str] = None          # a requirements file inside the checkout to install
    overrides: list = field(default_factory=list)   # versions forced over what dependencies ask for (uv --override)
    repo_code: bool = False                     # runs code from the model's own repository (cloned or trust_remote_code)
    # Python run in the venv (cwd: the checkout) once everything is in place: loads the engine so the helper models it
    # fetches on first load arrive during the install, not during someone's first render. {weights} is its folder.
    warmup: Optional[str] = None
    # file patterns the weights download leaves out: repos that ship every weight twice (.bin and .safetensors)
    # would otherwise download it all twice
    skip: list = field(default_factory=list)
    # engines that run inside the backend's own environment have no venv of their own, only weights to fetch ahead of the
    # first render: [(hub repo, [file patterns])], the same files the engine's own loader asks for
    prefetch: list = field(default_factory=list)

    @property
    def auto(self) -> bool:
        return self.manual is None and (self.venv is not None or bool(self.prefetch))


_T211 = "2.11.0"
# separator modes -> UVR model file (audio-separator downloads them into <weights>/separator)
SEPARATOR_MODELS = {"vocals": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
                    "denoise": "denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt",
                    "dereverb": "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt"}
_INDEX_GIT = ("https://github.com/index-tts/index-tts.git", "d9e41aac89fd00b3d71497fddb287b7f24613712", "indextts-repo")
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
             weights=[("cvssp/audioldm2", "audioldm2", "c8e7e189d324425c05c4c2f81214041ef4107983")], skip=["*.bin"], check="diffusers",
             notes="sound effects; shares the sfx venv with musicgen; about 4.5 GB of weights"),
    Manifest("musicgen", "sfx", _T211, packages=["diffusers==0.35.2", "transformers==4.57.3", "accelerate==1.12.0", "scipy", "soundfile"],
             weights=[("facebook/musicgen-small", "musicgen-small", "4c8334b02c6ec4e8664a91979669a501ec497792")], skip=["*.bin"],
             check="transformers", notes="music beds; shares the sfx venv with audioldm2; about 2.4 GB of weights"),
    Manifest("separator", "separator", _T211, packages=["audio-separator[cpu]==0.48.0", "audioread", "soundfile"], check="audio_separator",
             warmup=("import logging; from audio_separator.separator import Separator; "
                     "s = Separator(model_file_dir='{weights}', output_dir='{weights}', log_level=logging.WARNING); "
                     "[s.load_model(model_filename=m) for m in " + repr(list(SEPARATOR_MODELS.values())) + "]; print('ready')"),
             notes="voice/music separation and neural denoise (UVR RoFormer models via audio-separator, MIT; model licences vary); "
                   "about 1.5 GB of models"),
    Manifest("chatterbox-turbo", None, check="chatterbox", prefetch=[("ResembleAI/chatterbox-turbo", ["*.safetensors", "*.json", "*.txt", "*.pt", "*.model"])],
             notes="runs inside the backend's own environment (the `gpu` extra, which the desktop app installs); this fetches its weights"),
    Manifest("chatterbox", None, check="chatterbox",
             prefetch=[("ResembleAI/chatterbox", ["ve.safetensors", "t3_cfg.safetensors", "s3gen.safetensors", "tokenizer.json", "conds.pt"])],
             notes="runs inside the backend's own environment (the `gpu` extra); this fetches its weights"),
    Manifest("chatterbox-vc", None, check="chatterbox", prefetch=[("ResembleAI/chatterbox", ["s3gen.safetensors", "conds.pt"])],
             notes="runs inside the backend's own environment (the `gpu` extra); this fetches its weights"),
    Manifest("indextts2", "indextts", "2.8.0", python="3.11", git=_INDEX_GIT, editable=True, repo_code=True, packages=["hf_xet"],
             warmup="from indextts.infer_v2 import IndexTTS2; IndexTTS2(cfg_path='{weights}/config.yaml', model_dir='{weights}', "
                    "use_fp16=True, use_cuda_kernel=False, use_deepspeed=False); print('ready')",
             weights=[("IndexTeam/IndexTTS-2", "indextts-2", "740dcaff396282ffb241903d150ac011cd4b1ede")], check="indextts",
             notes="runs code from github.com/index-tts/index-tts (pinned); shares its venv with indextts25"),
    Manifest("indextts25", "indextts", "2.8.0", python="3.11", git=_INDEX_GIT, editable=True, repo_code=True, packages=["hf_xet"],
             warmup="from indextts.infer_v2_5 import IndexTTS2; IndexTTS2(cfg_path='{weights}/config.yaml', model_dir='{weights}', "
                    "use_bf16=True, use_cuda_kernel=False, use_deepspeed=False); print('ready')",
             weights=[("IndexTeam/IndexTTS-2.5", "indextts-2.5", "c39ce5ba981572cb187443877ff559dfb246ce63")], check="indextts",
             notes="runs code from github.com/index-tts/index-tts (pinned); shares its venv with indextts2"),
    Manifest("ming", "ming", "2.8.0", python="3.11", git=("https://github.com/inclusionAI/Ming-3.0-tts.git",
                                                         "a39b80660bdc5a4394d5e1d41af6dbfd9c443a54", "ming-repo"),
             requirements="requirements.txt", overrides=["torch==2.8.0", "torchaudio==2.8.0"], repo_code=True,
             weights=[("inclusionAI/Ming-3.0-tts-0.5b", "ming-3.0-tts-0.5b", "7247f4c94a5b2e987404ed28a5cfec41b1a4ca61")], check="x_transformers",
             notes="runs code from github.com/inclusionAI/Ming-3.0-tts (pinned); its torch 2.6 pin is lifted to 2.8 for RTX 50-series cards"),
    Manifest("moss", "moss", "2.9.1", packages=["transformers==5.0.0", "accelerate==1.12.0", "safetensors", "soundfile"], repo_code=True,
             weights=[("OpenMOSS-Team/MOSS-TTS-Local-Transformer-v1.5", "moss-tts-local-v1.5", "be7766a6735b98bd793f7c79fb720b4d0f5d13b8"),
                      ("OpenMOSS-Team/MOSS-Audio-Tokenizer-v2", "moss-audio-tokenizer-v2", "f6e20e543b33d2c252a7ef71bdf8aa71e5ff9169")],
             check="transformers", venv_gb=5.0,
             notes="model and codec code ship with the weights (trust_remote_code, pinned revisions); about 18 GB to download"),
    Manifest("breeze", "breeze", "2.9.1", manual="Breeze TTS 2 runs from a clone of its repository into <engines>/breeze-repo; "
             "its weights are research-only (BreezeBlue licence)", weights=[("MediaTek-Research/Breeze-TTS-2", "breeze-tts-2")]),
]}


def _name(engine: str) -> str:
    from .core.brands import name_of
    return name_of(engine)


def _forget_status() -> None:
    """Engine status is cached for a few seconds; an install or removal shows at once."""
    import importlib
    from .core import catalog
    importlib.invalidate_caches()      # packages installed while the server runs (the app's setup does that) are found at once
    catalog._STATUS.clear()


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
    # Hugging Face's xet downloader keeps whole files in memory and writes them at the end: no real progress to show, and
    # an interrupted download starts over. The plain downloader grows the file as it goes and resumes where it stopped.
    env.setdefault("HF_HUB_DISABLE_XET", "1")
    env["PYTHONUTF8"] = "1"
    env.pop("VIRTUAL_ENV", None)
    return env


MARKER = ".firevoice-install.json"


def _wanted(m: Manifest) -> list:
    return (sorted([f"torch=={m.torch}"] if m.torch else []) + sorted(m.packages + (m.windows_extra if os.name == "nt" else []))
            + ([f"git:{m.git[1]}"] if m.git else []))


def _weights(m: Manifest) -> list[tuple]:
    """(hub repo, folder, revision or None) for every weights entry (entries may omit the revision)."""
    return [(w[0], w[1], w[2] if len(w) > 2 else None) for w in m.weights]


def _git(args: list[str], log, cancel, env) -> None:
    git = shutil.which("git")
    if not git:
        raise InstallError("git is needed to fetch this engine's code: install Git for Windows (https://git-scm.com)")
    _run([git, *args], log, cancel, env)


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
    return w.exists() and any(w.glob("*")) and not any(".cache" not in f.parts for f in w.rglob("*.incomplete"))


def _repo_size(repo: str, revision: Optional[str] = None, skip: list = (), allow: list = ()) -> Optional[int]:
    try:
        from fnmatch import fnmatch
        from huggingface_hub import HfApi
        info = HfApi().model_info(repo, revision=revision, files_metadata=True)
        return sum((s.size or 0) for s in info.siblings or []
                   if not any(fnmatch(s.rfilename, p) for p in skip) and (not allow or any(fnmatch(s.rfilename, p) for p in allow)))
    except Exception:
        return None


def plan(engine: str, sizes: bool = False) -> dict:
    """What an install would do, what is already there, and roughly how much it downloads."""
    m = manifest(engine)
    steps = []
    if m.venv is None and m.check:
        import importlib.util
        steps.append({"step": "package", "what": f"python package {m.check} (installed with the backend's `gpu` extra)",
                      "done": importlib.util.find_spec(m.check) is not None})
    for repo, patterns in m.prefetch:
        st = {"step": "weights", "what": f"{repo} ({', '.join(patterns)})", "repo": repo, "done": hub_ok(repo, patterns)}
        if sizes and not st["done"]:
            b = _repo_size(repo, None, (), patterns)
            st["gb"] = round(b / 1e9, 2) if b else None
        steps.append(st)
    if m.venv:
        steps.append({"step": "venv", "what": f"Python {m.python} venv at {paths.engines_dir() / m.venv}", "done": venv_ok(m)})
        if m.git:
            steps.append({"step": "code", "what": f"{m.git[0]} at {m.git[1][:10]} -> {paths.engines_dir() / m.git[2]}", "done": venv_ok(m)})
        if m.torch:
            steps.append({"step": "torch", "what": f"torch {m.torch} (CUDA 12.8)", "done": venv_ok(m)})
        pk = m.packages + (m.windows_extra if os.name == "nt" else [])
        if pk:
            steps.append({"step": "packages", "what": ", ".join(pk), "done": venv_ok(m)})
    for repo, folder, rev in _weights(m):
        st = {"step": "weights", "what": f"{repo}{'@' + rev[:10] if rev else ''} -> {paths.weights(folder)}", "repo": repo, "folder": folder,
              "done": weights_ok(folder)}
        if sizes and not st["done"]:
            b = _repo_size(repo, rev, m.skip)
            st["gb"] = round(b / 1e9, 2) if b else None
        steps.append(st)
    if m.check and m.venv is not None:
        steps.append({"step": "check", "what": f"import {m.check}", "done": venv_ok(m)})
    todo_gb = sum(s.get("gb") or 0 for s in steps if s["step"] == "weights" and not s["done"])
    if m.venv and not venv_ok(m):
        todo_gb += m.venv_gb
    return {"engine": m.engine, "auto": m.auto, "manual": m.manual, "notes": m.notes, "venv": m.venv, "repo_code": m.repo_code,
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


def _shared_wheels() -> list[str]:
    """`--find-links` to the torch wheels the desktop app downloaded for its own runtime (FIREVOICE_WHEELS), so an engine
    on the same torch build does not download those gigabytes again. Empty outside the desktop app."""
    d = os.environ.get("FIREVOICE_WHEELS")
    return ["--find-links", d] if d and Path(d).is_dir() else []


def _wait_for_shared_download(progress: Callable[[str], None], cancel: threading.Event, limit_s: float = 3 * 3600) -> None:
    """While the desktop app is still downloading torch into FIREVOICE_WHEELS, wait for it instead of fetching the same
    file in parallel. The downloader refreshes its marker every few seconds; a stale one (the app quit) is ignored."""
    d = os.environ.get("FIREVOICE_WHEELS")
    if not d:
        return
    marker = Path(d) / ".downloading"
    t0 = time.time()
    told = False
    while marker.exists() and time.time() - t0 < limit_s:
        try:
            if time.time() - marker.stat().st_mtime > 60:
                return
        except OSError:
            return
        if not told:
            progress("Waiting for FireVoice's GPU support download to finish (this engine uses the same files)")
            told = True
        if cancel.wait(2):
            return


MAIN_TORCH = "2.11.0"        # the torch of the app's own runtime (scripts/backend-recipe.mjs): engines on it share its files


def hub_ok(repo: str, patterns: list) -> bool:
    """Whether every file an engine's loader asks the Hugging Face hub for is already in the local cache (no network)."""
    try:
        from huggingface_hub import snapshot_download
        snapshot_download(repo, allow_patterns=list(patterns), local_files_only=True)
        return True
    except Exception:
        return False


def _drive(p: Path) -> str:
    return Path(p).anchor or str(p)


def disk_message(need_gb: Optional[float], where: Path, free_gb: Optional[float] = None) -> str:
    """The plain-language "disk is full" message; `need_gb` None when only the failure is known, not the amount."""
    from .hardware import free_gb as _free
    free = free_gb if free_gb is not None else _free(where)
    have = f"{free:.1f} GB is free on {_drive(where)}" if free is not None else f"{_drive(where)} is full"
    if need_gb:
        need = f"This needs about {need_gb:.1f} GB and {have}. "
    else:
        need = f"Drive {_drive(where)} has only {free:.1f} GB free. " if free is not None else f"Drive {_drive(where)} is full. "
    return ("Not enough free disk space. " + need +
            "Free some space and try again, or move the engines folder to a bigger drive (Settings, Engines and storage).")


def _check_disk(need_gb: float, where: Optional[Path] = None) -> None:
    from .hardware import free_gb as _free
    where = where or paths.engines_dir()
    free = _free(where)
    if free is not None and free < need_gb:
        raise InstallError(disk_message(need_gb, where, free))


def _need_gb(m: "Manifest", weights_gb: float, build: bool) -> float:
    """What an install adds: its own environment (small when it shares the runtime's torch), its weights, and slack."""
    own = 0.0
    if build:
        own = m.venv_gb if (m.torch and m.torch != MAIN_TORCH) else min(m.venv_gb, 2.0)
    return round(own + weights_gb + 1.0, 1)


_DISK = ("os error 112", "not enough space", "no space left", "enospc", "disk is full", "there is not enough space")
_NET = ("error sending request", "connection refused", "connection reset", "timed out", "dns error", "failed to lookup", "name resolution",
        "temporary failure", "connectionerror", "max retries exceeded", "ssl", "network is unreachable", "tls handshake")
_DENIED = ("access is denied", "os error 5", "permission denied", "winerror 5")


def friendly(lines: list, where: Optional[Path] = None) -> Optional[str]:
    """A plain-language reason for a failed command from the last lines it printed, or None when nothing is recognised."""
    text = " | ".join(lines).lower()
    if any(k in text for k in _DISK):
        import re
        # the failing drive is the one in the error's own path (often uv's cache, not the engines folder)
        hit = re.search(r"([A-Za-z]:[\\/][^\s'`\"|]*)", " | ".join(lines))
        return disk_message(None, Path(hit.group(1)) if hit else (where or paths.engines_dir()))
    if any(k in text for k in _DENIED):
        return ("Windows would not let FireVoice write its files (an antivirus or a protected folder?). Allow FireVoice in your antivirus, "
                "or choose another folder for the engines in Settings, Engines and storage, then try again.")
    if any(k in text for k in _NET):
        return "FireVoice could not reach the download servers. Check your internet connection (and any proxy or firewall) and try again."
    return None


def _run(cmd: list[str], log, cancel: threading.Event, env: Optional[dict] = None, on_line: Optional[Callable[[str], None]] = None,
         cwd: Optional[str] = None) -> None:
    log(f"$ {' '.join(cmd)}")
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                         env=env, creationflags=flags, cwd=cwd)
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
        why = friendly(tail)
        raise InstallError(why or f"{Path(cmd[0]).name} exited with {p.returncode}: " + " | ".join(tail[-4:]))


# Weights go through the shared Hugging Face cache, then are hardlinked into the weights folder (copied when the cache is
# on another drive): a model already fetched by anything on this machine is not downloaded again.
_FETCH = """
import os, shutil, sys
from huggingface_hub import snapshot_download
skip = [p for p in (sys.argv[4] if len(sys.argv) > 4 else "").split("|") if p] or None
src = snapshot_download(sys.argv[1], revision=(sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None), ignore_patterns=skip)
dst = sys.argv[2]
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
        raise InstallError(m.manual or f"{_name(m.engine)} cannot be installed automatically")
    if m.venv is None:
        return _install_main(m, progress, cancel, log_file, force)
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
    todo_weights = [(r, f, v) for r, f, v in _weights(m) if force or not weights_ok(f)]
    build = force or not venv_ok(m)
    warm = bool(m.warmup) and (build or bool(todo_weights) or not (paths.engines_dir() / m.venv / f".warm-{m.engine}").exists())
    steps = (3 + (1 if m.git else 0) if build else 0) + len(todo_weights) + (1 if warm else 0) + 1
    k = 0
    t0 = time.time()
    try:
        # not enough room is told at once, in plain words, instead of half way through a multi-gigabyte download
        wgb = sum((_repo_size(r, v, m.skip) or 0) for r, _f, v in todo_weights) / 1e9
        _check_disk(_need_gb(m, wgb, build))
        with _venv_lock(m.venv):
            if build:
                paths.engines_dir().mkdir(parents=True, exist_ok=True)
                progress(k, steps, "Preparing a private Python for this engine")
                _run([u, "venv", "--allow-existing", "--python", m.python, str(paths.engines_dir() / m.venv)], log, cancel, env)
                _write_marker(m, "building")
                k += 1
                if m.torch:
                    _wait_for_shared_download(lambda msg: progress(k, steps, msg), cancel)
                    if cancel.is_set():
                        raise InstallCancelled("cancelled")
                    progress(k, steps, "Installing GPU support (about 3 GB the first time)")
                    pk = [f"torch=={m.torch}"] + ([f"torchaudio=={m.torch}"] if m.torchaudio else [])
                    _run([u, "pip", "install", "--python", str(py), *pk, "--index-url", torch_index(), *_shared_wheels()], log, cancel, env)
                k += 1
                extra: list[str] = []
                if m.git:
                    url, commit, folder = m.git
                    repo_dir = paths.engines_dir() / folder
                    progress(k, steps, "Fetching the engine's code")
                    if not (repo_dir / ".git").exists():
                        _git(["clone", "--filter=blob:none", "--no-checkout", url, str(repo_dir)], log, cancel, env)
                    _git(["-C", str(repo_dir), "fetch", "--depth", "1", "origin", commit], log, cancel, env)
                    _git(["-C", str(repo_dir), "checkout", "--force", commit], log, cancel, env)
                    k += 1
                    if m.requirements:
                        extra += ["-r", str(repo_dir / m.requirements)]
                    if m.editable:
                        extra += ["-e", str(repo_dir)]
                pk = m.packages + (m.windows_extra if os.name == "nt" else [])
                progress(k, steps, "Installing the engine")
                # keep the CUDA torch: the engine packages must not swap it for PyPI's CPU build
                pin = [f"torch=={m.torch}"] + ([f"torchaudio=={m.torch}"] if m.torchaudio else []) if m.torch else []
                ovr: list[str] = []
                if m.overrides:
                    of = paths.engines_dir() / f".{m.venv}-overrides.txt"
                    of.write_text("\n".join(m.overrides), encoding="utf-8")
                    ovr = ["--override", str(of)]
                _run([u, "pip", "install", "--python", str(py), *pk, *extra, *pin, *ovr, "--extra-index-url", torch_index(),
                      "--index-strategy", "unsafe-best-match"], log, cancel, env)
                k += 1
            for repo, folder, rev in todo_weights:
                dest = paths.weights(folder)
                dest.mkdir(parents=True, exist_ok=True)
                total = _repo_size(repo, rev, m.skip)
                label = "Downloading the model" + (f" ({total / 1e9:.1f} GB)" if total else "")
                progress(k, steps, label)
                stop = threading.Event()
                cache = _hub_cache_dir(repo)
                start_bytes = _dir_bytes(cache) if cache else 0

                def watch(k=k, dest=dest, total=total, label=label, cache=cache, start_bytes=start_bytes):
                    while not stop.wait(2.0):
                        if total:
                            have = max(_dir_bytes(dest), (_dir_bytes(cache) - start_bytes) if cache else 0)
                            progress(k + min(0.99, have / total), steps, f"{label}: {min(100, round(100 * have / total))}%")
                w = threading.Thread(target=watch, daemon=True)
                w.start()
                try:
                    _run([sys.executable, "-c", _FETCH, repo, str(dest), rev or "", "|".join(m.skip)], log, cancel, env)
                finally:
                    stop.set()
                k += 1
            if warm:
                progress(k, steps, "First start: fetching helper models")
                repo_dir = str(paths.engines_dir() / m.git[2]) if m.git else None
                wenv = {**env, "PYTHONPATH": repo_dir or "", "PYTHONUTF8": "1"}
                wdir = paths.weights(_weights(m)[0][1] if m.weights else m.engine)
                wdir.mkdir(parents=True, exist_ok=True)
                code = m.warmup.replace("{weights}", str(wdir).replace("\\", "/"))
                _run([str(py), "-c", code], log, cancel, wenv, cwd=repo_dir)
                (paths.engines_dir() / m.venv / f".warm-{m.engine}").write_text(m.engine, encoding="utf-8")
                k += 1
            if m.check:
                progress(k, steps, "Checking the install")
                # the engine worker puts a checkout on PYTHONPATH and runs inside it; check the same way
                rd = str(paths.engines_dir() / m.git[2]) if m.git else None
                cenv = {**env, "PYTHONPATH": rd} if rd else env
                _run([str(py), "-c", f"import {m.check}, torch; print('cuda', torch.cuda.is_available())"], log, cancel, cenv, cwd=rd)
            if build:
                _write_marker(m, "ok")
            k += 1
    finally:
        if fh:
            fh.close()
    progress(steps, steps, "installed")
    _forget_status()
    return {"engine": m.engine, "venv": str(paths.engines_dir() / m.venv), "built_venv": build,
            "weights": [f for _, f, _ in todo_weights], "seconds": round(time.time() - t0, 1)}


_PREFETCH = """
import json, sys
from huggingface_hub import snapshot_download
snapshot_download(sys.argv[1], allow_patterns=json.loads(sys.argv[2]))
"""


def _install_main(m: Manifest, progress: Callable[[float, float, str], None], cancel: threading.Event, log_file: Optional[Path], force: bool) -> dict:
    """An engine that runs inside the backend's own environment: nothing to build, only its weights to fetch (into the
    Hugging Face cache, where the engine's own loader looks), with real progress."""
    import importlib.util
    import json
    fh = open(log_file, "a", encoding="utf-8") if log_file else None

    def log(line: str) -> None:
        if fh:
            fh.write(line + "\n")
            fh.flush()
    t0 = time.time()
    try:
        if m.check and importlib.util.find_spec(m.check) is None:
            raise InstallError("FireVoice is still setting up its environment (the graphics support download has not finished). Try again in a few minutes.")
        todo = [(r, p) for r, p in m.prefetch if force or not hub_ok(r, p)]
        sizes = [_repo_size(r, None, (), p) or 0 for r, p in todo]
        _check_disk(_need_gb(m, sum(sizes) / 1e9, False))
        env = uv_env()
        total_all = max(sum(sizes), 1)
        done_before = 0
        for (repo, patterns), size in zip(todo, sizes):
            label = f"Downloading {_name(m.engine)}" + (f" ({size / 1e9:.1f} GB)" if size else "")
            progress(done_before, total_all, label)
            stop = threading.Event()
            cache = _hub_cache_dir(repo)
            start = _dir_bytes(cache) if cache else 0

            def watch(base=done_before, size=size, label=label, cache=cache, start=start):
                while not stop.wait(1.5):
                    if size and cache:
                        # never claim the end before the download process has really finished: files in the cache
                        # can show their full size before their bytes have arrived
                        have = min(max(0, _dir_bytes(cache) - start), int(size * 0.99))
                        progress(base + have, total_all, f"{label}: {round(100 * have / size)}%")
            t = threading.Thread(target=watch, daemon=True)
            t.start()
            try:
                _run([sys.executable, "-c", _PREFETCH, repo, json.dumps(patterns)], log, cancel, env)
            finally:
                stop.set()
            done_before += size
        _forget_status()
        progress(total_all, total_all, "installed")
    finally:
        if fh:
            fh.close()
    return {"engine": m.engine, "venv": None, "built_venv": False, "weights": [r for r, _ in m.prefetch], "seconds": round(time.time() - t0, 1)}


def uninstall(engine: str, weights: bool = False) -> dict:
    """Remove the engine's venv (shared venvs such as qwen go for every engine that uses them) and, optionally, its weights."""
    m = manifest(engine)
    if m.venv is None:
        raise InstallError(f"{_name(m.engine)} runs inside the backend's own environment and cannot be removed here")
    removed = []
    with _venv_lock(m.venv):
        d = paths.engines_dir() / m.venv
        if d.exists():
            shutil.rmtree(d)
            removed.append(str(d))
        if weights:
            for _, folder, _rev in _weights(m):
                w = paths.weights(folder)
                if w.exists():
                    shutil.rmtree(w)
                    removed.append(str(w))
    shared = sorted(e for e, x in MANIFESTS.items() if x.venv == m.venv and e != m.engine)
    _forget_status()
    return {"engine": m.engine, "removed": removed, "also_affects": shared}


def manifests() -> list[dict]:
    return [{**asdict(m), "auto": m.auto} for m in MANIFESTS.values()]
