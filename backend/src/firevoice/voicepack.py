"""The voice library: ready-made voices, fetched once during setup and added to ~/.firevoice/voices.

The pack is one zip (`pack.json` + `voices/<id>/{meta.json, ref.wav, ref.txt, preview.mp3, avatar.png}`) published next
to the app's releases and described by `voicepack.json` in this package: its version, URL, size, SHA-256, the ids it
holds and the voice that is the default. `scripts/build-voices-pack.mjs` builds the zip and rewrites that file.

Installing is safe to repeat and never takes anything away from a person:
* a voice that already exists is left exactly as it is (edited, renamed or replaced voices stay);
* every id the pack ever delivered is remembered in voices/library.json, so a voice deleted afterwards does not come back;
* the default voice is set only when none is set yet.
The download resumes after an interruption, is checked against its SHA-256, and needs room for the zip and its contents.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable, Optional

from . import paths
from .voices import _slug, write_json_atomic, write_text_atomic

INFO_FILE = Path(__file__).with_name("voicepack.json")
LIBRARY_FILE = "library.json"
UA = {"User-Agent": "FireVoice"}
Progress = Callable[[int, int, str], None]


class VoicePackError(RuntimeError):
    pass


class VoicePackCancelled(RuntimeError):
    pass


def info() -> dict:
    """The pack this version of FireVoice delivers: {version, url, bytes, sha256, ids, default}. `FIREVOICE_VOICES_URL`
    points the download somewhere else (a mirror, or a local file while testing); the checksum still has to match."""
    d = json.loads(INFO_FILE.read_text(encoding="utf-8")) if INFO_FILE.exists() else {}
    d.setdefault("version", 0)
    d.setdefault("ids", [])
    if os.environ.get("FIREVOICE_VOICES_URL"):
        d["url"] = os.environ["FIREVOICE_VOICES_URL"]
    return d


def _delivered(root: Path) -> dict:
    f = root / LIBRARY_FILE
    try:
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    except Exception:
        return {}


def status(root: Optional[Path] = None, pack: Optional[dict] = None) -> dict:
    """What the library has of the pack: {version, count, present, missing, installed, bytes, available}."""
    root = Path(root) if root else paths.home() / "voices"
    pack = pack or info()
    ids = list(pack.get("ids") or [])
    gone = set(_delivered(root).get("ids") or [])
    present = [i for i in ids if (root / _slug(i) / "meta.json").exists()]
    # a voice delivered earlier and deleted since is not missing: the person removed it
    missing = [i for i in ids if i not in present and i not in gone]
    return {"version": pack.get("version", 0), "count": len(ids), "present": len(present), "missing": len(missing),
            "installed": bool(ids) and not missing, "bytes": pack.get("bytes"), "available": bool(pack.get("url") and ids)}


def _safe(name: str) -> Optional[tuple]:
    """('<id>', '<file>') for 'voices/<id>/<file>' or 'voices/<id>/refs/<file>' (a style clip) with plain names only, else
    None (no '..', drive letters or absolute paths)."""
    parts = name.replace("\\", "/").split("/")
    if parts[:1] != ["voices"] or len(parts) not in (3, 4) or (len(parts) == 4 and parts[2] != "refs"):
        return None
    if any(p in ("", ".", "..") or ":" in p for p in parts):
        return None
    return parts[1], "/".join(parts[2:])


def _free(path: Path) -> int:
    p = Path(path)
    while not p.exists() and p.parent != p:
        p = p.parent
    return shutil.disk_usage(p).free


def _download(url: str, dest: Path, size: Optional[int], sha256: str, progress: Progress, cancel: threading.Event,
              label: str = "Downloading the voice library") -> None:
    """Fetch url into dest (resuming a partial file), checking size and SHA-256. Raises VoicePackError with a plain reason."""
    from .rate import Speedometer
    meter = Speedometer(label)
    part = dest.with_name(dest.name + ".part")
    if part.exists():
        meter.rebase(part.stat().st_size)          # resuming: what is already there is not speed
    dest.parent.mkdir(parents=True, exist_ok=True)
    local = url.startswith("file:")
    last_err = ""
    for attempt in range(6):
        if cancel.is_set():
            raise VoicePackCancelled("cancelled")
        try:
            have = part.stat().st_size if part.exists() else 0
            if size and have > size:
                part.unlink()
                have = 0
            headers = dict(UA)
            if have and not local:
                headers["Range"] = f"bytes={have}-"
            if not size or have < size:
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as r:
                    status = getattr(r, "status", 200)
                    if have and status != 206:
                        have = 0                       # the server ignored the range: start again
                    total = size or have + int(r.headers.get("Content-Length") or 0)
                    with open(part, "ab" if have else "wb") as f:
                        last = 0.0
                        while True:
                            if cancel.is_set():
                                raise VoicePackCancelled("cancelled")
                            chunk = r.read(1 << 20)
                            if not chunk:
                                break
                            f.write(chunk)
                            have += len(chunk)
                            now = time.monotonic()
                            if now - last > 0.25:
                                last = now
                                progress(have, max(total, have), meter.text(have, max(total, have)))
            if size and have != size:
                raise OSError(f"the download stopped at {have} of {size} bytes")
            h = hashlib.sha256()
            with open(part, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            if sha256 and h.hexdigest() != sha256:
                part.unlink(missing_ok=True)
                raise OSError("the voice library did not match its checksum; downloading it again")
            os.replace(part, dest)
            progress(have, max(size or have, have), "Downloaded the voice library")
            return
        except VoicePackCancelled:
            raise
        except OSError as e:                       # includes URLError and timeouts: wait, then carry on from where it stopped
            last_err = str(e)
            if "space" in last_err.lower() or getattr(e, "errno", None) in (28, 112):
                raise VoicePackError(_disk_message(dest.parent, (size or 0) * 2.5)) from e
            if attempt == 5:
                break
            for _ in range(min(20, 2 ** attempt)):
                if cancel.is_set():
                    raise VoicePackCancelled("cancelled")
                time.sleep(1)
    raise VoicePackError(f"Could not download the voice library ({last_err or 'no connection'}). Check your internet connection and try again.")


def _disk_message(where: Path, need_bytes: float) -> str:
    free = _free(where)
    drive = Path(where).anchor or str(where)
    return (f"Not enough free disk space for the voice library: it needs about {need_bytes / 1e9:.1f} GB on {drive} and only "
            f"{free / 1e9:.1f} GB is free. Free some space and try again.")


def install(progress: Progress, cancel: Optional[threading.Event] = None, root: Optional[Path] = None, pack: Optional[dict] = None) -> dict:
    """Download the pack and add its voices. `progress(done, total, message)`. -> {added, skipped, default, version}."""
    cancel = cancel or threading.Event()
    root = Path(root) if root else paths.home() / "voices"
    pack = pack or info()
    if not pack.get("url") or not pack.get("ids"):
        raise VoicePackError("This version of FireVoice has no voice library to download.")
    size = int(pack.get("bytes") or 0)
    need = size * 2.5                              # the zip, plus what comes out of it, plus slack
    if size and _free(root) < need:
        raise VoicePackError(_disk_message(root, need))
    zpath = paths.home() / "downloads" / f"voices-{pack['version']}.zip"
    _download(pack["url"], zpath, size or None, pack.get("sha256") or "", progress, cancel)
    root.mkdir(parents=True, exist_ok=True)
    delivered = _delivered(root)
    seen = set(delivered.get("ids") or [])
    added, skipped = [], []
    try:
        with zipfile.ZipFile(zpath) as z:
            members: dict[str, list] = {}
            for n in z.namelist():
                s = _safe(n)
                if s:
                    members.setdefault(s[0], []).append((n, s[1]))
            total = len(members)
            for k, (vid, files) in enumerate(sorted(members.items())):
                if cancel.is_set():
                    raise VoicePackCancelled("cancelled")
                progress(k, total, f"Adding voices: {k + 1} of {total}")
                dst = root / _slug(vid)
                if (dst / "meta.json").exists() or vid in seen:
                    skipped.append(vid)            # edited, renamed or deleted by the person: never touched
                    continue
                tmp = root / f".adding-{_slug(vid)}"
                shutil.rmtree(tmp, ignore_errors=True)
                tmp.mkdir(parents=True)
                for n, f in files:
                    (tmp / f).parent.mkdir(parents=True, exist_ok=True)
                    with z.open(n) as src, open(tmp / f, "wb") as out:
                        shutil.copyfileobj(src, out)
                if not (tmp / "meta.json").exists() or not (tmp / "ref.wav").exists():
                    shutil.rmtree(tmp, ignore_errors=True)
                    continue
                shutil.rmtree(dst, ignore_errors=True)
                os.replace(tmp, dst)               # a voice appears whole or not at all
                added.append(vid)
    except zipfile.BadZipFile as e:
        zpath.unlink(missing_ok=True)
        raise VoicePackError("The downloaded voice library is damaged. Try again.") from e
    except OSError as e:
        if getattr(e, "errno", None) in (28, 112) or "space" in str(e).lower():
            raise VoicePackError(_disk_message(root, need)) from e
        raise
    write_json_atomic(root / LIBRARY_FILE, {"version": pack["version"], "ids": sorted(seen | set(added) | set(skipped))})
    default = pack.get("default")
    if default and not (root / "default.txt").exists() and (root / _slug(default) / "meta.json").exists():
        write_text_atomic(root / "default.txt", _slug(default))
    zpath.unlink(missing_ok=True)
    progress(1, 1, "Voices added")
    return {"added": len(added), "skipped": len(skipped), "version": pack["version"], "default": default}
