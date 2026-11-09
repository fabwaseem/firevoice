"""Where FireVoice keeps things, so the backend runs from a source checkout, a pip install or a desktop bundle alike.

Every location is resolved in the same order: an environment variable, then `settings.json` in the data folder, then
the source checkout (when this package runs from one that has the folder), then a default inside the data folder.

| what                    | env var               | settings.json key | checkout             | default                      |
|-------------------------|-----------------------|-------------------|----------------------|------------------------------|
| data (voices, renders)  | FIREVOICE_HOME        | (none)            | (none)               | ~/.firevoice                 |
| engine venvs and repos  | FIREVOICE_ENGINES_DIR | engines_dir       | <checkout>/.envs     | <home>/engines               |
| model weights           | FIREVOICE_WEIGHTS_DIR | weights_dir       | <checkout>/.envs/weights | <engines dir>/weights   |
| ffmpeg                  | FIREVOICE_FFMPEG      | ffmpeg            | (none)               | <home>/bin, then PATH, then imageio-ffmpeg |

This module imports nothing heavy: engine workers (each in its own venv) import it too. Values are read at call time,
so a changed settings file applies to anything resolved later; engine venv paths are fixed when the engine registry
loads, so changing `engines_dir` needs a restart (the settings route says so).
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Optional

PACKAGE = Path(__file__).resolve().parent            # .../firevoice (the package)
_CHECKOUT = PACKAGE.parents[1]                         # the repo root when running from src/ (firevoice/)
SETTINGS_KEYS = ("engines_dir", "weights_dir", "ffmpeg", "watermark")
EXE = ".exe" if os.name == "nt" else ""


def home() -> Path:
    """The data folder (voices, styles, renders, projects, logs): $FIREVOICE_HOME or ~/.firevoice."""
    return Path(os.environ.get("FIREVOICE_HOME") or Path.home() / ".firevoice")


def checkout() -> Optional[Path]:
    """The source checkout this package runs from, if it is one (has pyproject.toml next to src/)."""
    return _CHECKOUT if (_CHECKOUT / "pyproject.toml").exists() and (_CHECKOUT / "src" / "firevoice").is_dir() else None


def settings_file() -> Path:
    return home() / "settings.json"


def settings() -> dict:
    try:
        d = json.loads(settings_file().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_settings(changes: dict) -> dict:
    """Merge path settings (None or "" removes a key). Returns the stored settings."""
    bad = [k for k in changes if k not in SETTINGS_KEYS]
    if bad:
        raise ValueError(f"unknown setting(s): {', '.join(bad)}; known: {', '.join(SETTINGS_KEYS)}")
    d = settings()
    for k, v in changes.items():
        if v in (None, ""):
            d.pop(k, None)
        else:
            d[k] = str(v)
    f = settings_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    os.replace(tmp, f)
    return d


def _pick(env: str, key: str, dev: Optional[Path], default: Path) -> tuple[Path, str]:
    if os.environ.get(env):
        return Path(os.environ[env]), f"env {env}"
    s = settings().get(key)
    if s:
        return Path(s), "settings.json"
    if dev is not None and dev.exists():
        return dev, "source checkout"
    return default, "default"


def engines_dir_info() -> tuple[Path, str]:
    co = checkout()
    return _pick("FIREVOICE_ENGINES_DIR", "engines_dir", co / ".envs" if co else None, home() / "engines")


def engines_dir() -> Path:
    """Engine venvs (<dir>/<venv>/) and cloned repos (<dir>/<name>-repo/)."""
    return engines_dir_info()[0]


def weights_dir_info() -> tuple[Path, str]:
    if os.environ.get("FIREVOICE_WEIGHTS_DIR"):
        return Path(os.environ["FIREVOICE_WEIGHTS_DIR"]), "env FIREVOICE_WEIGHTS_DIR"
    if settings().get("weights_dir"):
        return Path(settings()["weights_dir"]), "settings.json"
    d, src = engines_dir_info()
    return d / "weights", f"engines dir ({src})"


def weights_dir() -> Path:
    """Pinned model weights (<dir>/<name>/)."""
    return weights_dir_info()[0]


def weights(name: str) -> Path:
    return weights_dir() / name


def venv_python(venv: str) -> Path:
    d = engines_dir() / venv
    return d / "Scripts" / "python.exe" if os.name == "nt" else d / "bin" / "python"


def ffmpeg_info() -> tuple[Optional[str], str]:
    if os.environ.get("FIREVOICE_FFMPEG"):
        return os.environ["FIREVOICE_FFMPEG"], "env FIREVOICE_FFMPEG"
    if settings().get("ffmpeg"):
        return settings()["ffmpeg"], "settings.json"
    bundled = home() / "bin" / f"ffmpeg{EXE}"
    if bundled.exists():
        return str(bundled), "data folder bin/"
    found = shutil.which("ffmpeg")
    if found:
        return found, "PATH"
    try:
        import imageio_ffmpeg  # optional: ships a static ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe(), "imageio-ffmpeg"
    except Exception:
        return None, "missing"


def ffmpeg() -> Optional[str]:
    return ffmpeg_info()[0]


def worker_src() -> Path:
    """A folder to put on an engine worker's PYTHONPATH so it can import this package (the worker runs in the engine's
    own venv, which does not have FireVoice installed).

    From a checkout that is src/. From an install it must not be site-packages: that folder ahead of the engine venv's
    standard library lets stray packages there (an old `typing` backport, say) shadow the real ones. So the package is
    copied once into <home>/runtime/worker-src/<fingerprint>/, a folder that holds nothing else and never changes once
    written (a new version gets a new folder)."""
    co = checkout()
    if co is not None:
        return co / "src"
    import hashlib
    files = sorted(f for f in PACKAGE.rglob("*.py") if "__pycache__" not in f.parts)
    h = hashlib.sha1()
    for f in files:
        st = f.stat()
        h.update(f"{f.relative_to(PACKAGE).as_posix()}|{st.st_size}|{int(st.st_mtime)}".encode())
    dest = home() / "runtime" / "worker-src" / h.hexdigest()[:12]
    if not (dest / "firevoice" / ".complete").exists():
        tmp = dest.with_name(dest.name + f".tmp{os.getpid()}")
        shutil.rmtree(tmp, ignore_errors=True)
        for f in files:
            out = tmp / "firevoice" / f.relative_to(PACKAGE)
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, out)
        (tmp / "firevoice" / ".complete").write_text("")
        try:
            os.replace(tmp, dest)
        except OSError:          # another process finished first; theirs is identical
            shutil.rmtree(tmp, ignore_errors=True)
    return dest


def models_dir() -> Path:
    """Small auxiliary models fetched on demand (RNNoise...)."""
    return home() / "models"


def report() -> dict:
    """Every resolved location with where it came from (for `firevoice doctor` and GET /api/v1/system/paths)."""
    e, es = engines_dir_info()
    w, ws = weights_dir_info()
    f, fs = ffmpeg_info()
    return {
        "home": {"path": str(home()), "source": "env FIREVOICE_HOME" if os.environ.get("FIREVOICE_HOME") else "default", "exists": home().exists()},
        "engines_dir": {"path": str(e), "source": es, "exists": e.exists()},
        "weights_dir": {"path": str(w), "source": ws, "exists": w.exists()},
        "ffmpeg": {"path": f, "source": fs, "exists": bool(f and Path(f).exists())},
        "package": {"path": str(PACKAGE), "checkout": str(checkout()) if checkout() else None},
        "settings_file": str(settings_file()),
        "settings": settings(),
    }
