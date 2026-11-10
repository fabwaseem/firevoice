"""History: every finished output kept until the user deletes it.

Speech renders already live in the kept-render store (takes/). Everything else made through the API lands here:
sound effects and music, voice changer output, dialogue mixes, transcripts, separated tracks and cleaned audio.

  <home>/history/<id>/item.json   {id, kind, title, created, duration, sample_rate, files, meta}
  <home>/history/<id>/<file>      audio as FLAC (lossless; served in any format on request), text and JSON as is

Records are written atomically and a record that cannot be read is skipped, never fatal. Nothing is pruned.
"""
from __future__ import annotations

import json
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import numpy as np

KINDS = ("sound", "music", "changer", "dialogue", "transcript", "separate", "clean")


def _write_atomic(path: Path, data: bytes) -> None:
    import os
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _flac(a: np.ndarray, sr: int) -> bytes:
    """Lossless FLAC with its length in the header (ffmpeg writing to a pipe leaves it out, and readers then fail)."""
    import io

    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, np.clip(a, -1.0, 1.0), sr, format="FLAC", subtype="PCM_24")
    return buf.getvalue()


class History:
    def __init__(self, root: Path):
        self.root = Path(root)
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ write
    def add(self, kind: str, title: str, *, audio: Optional[dict] = None, texts: Optional[dict] = None, meta: Optional[dict] = None,
            sr: Optional[int] = None, duration: Optional[float] = None, compressed: tuple = ()) -> dict:
        """Keep one output. `audio` maps a file stem to a mono float array at `sr` (stored as FLAC); `texts` maps a file
        name to a str or a JSON-able object. Stems in `compressed` are kept as MP3 (long source recordings)."""
        from . import audio as A
        if kind not in KINDS:
            raise ValueError(f"unknown history kind {kind!r}")
        now = time.time()
        # milliseconds in the id keep the folder order equal to the order things were made
        hid = time.strftime("%Y%m%d-%H%M%S", time.localtime(now)) + f"{int(now * 1000) % 1000:03d}-" + uuid.uuid4().hex[:6]
        d = self.root / hid
        d.mkdir(parents=True, exist_ok=True)
        files = {}
        try:
            for stem, a in (audio or {}).items():
                a = np.asarray(a, dtype=np.float32)
                fmt = "mp3" if stem in compressed else "flac"
                name = f"{stem}.{fmt}"
                _write_atomic(d / name, _flac(a, int(sr)) if fmt == "flac" else A.encode_bytes(a, int(sr), fmt, bitrate="128k"))
                files[stem] = {"file": name, "type": "audio", "duration": round(len(a) / float(sr), 3)}
            for name, body in (texts or {}).items():
                data = body if isinstance(body, str) else json.dumps(body, indent=1, ensure_ascii=False)
                _write_atomic(d / name, data.encode("utf-8"))
                files[name] = {"file": name, "type": "json" if name.endswith(".json") else "text"}
            first = next((f for f in files.values() if f["type"] == "audio"), None)
            item = {"id": hid, "kind": kind, "title": (title or kind).strip()[:200], "created": now,
                    "duration": duration if duration is not None else (first or {}).get("duration"), "sample_rate": sr,
                    "files": files, "meta": meta or {}}
            from .voices import write_json_atomic
            write_json_atomic(d / "item.json", item)
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            raise
        return item

    # ------------------------------------------------------------------ read
    def list(self, kind: Optional[str] = None, limit: int = 100, before: Optional[float] = None, q: Optional[str] = None) -> list[dict]:
        out = []
        kinds = set(kind.split(",")) if kind else None
        needle = (q or "").strip().lower()
        for f in sorted(self.root.glob("*/item.json"), reverse=True):
            try:
                m = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue                      # an unreadable record is skipped, never fatal
            if kinds and m.get("kind") not in kinds:
                continue
            if before is not None and m.get("created", 0) >= before:
                continue
            if needle and needle not in (m.get("title") or "").lower():
                continue
            out.append(m)
            if len(out) >= limit:
                break
        return out

    def get(self, hid: str) -> dict:
        f = self._dir(hid) / "item.json"
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise KeyError(f"no history item {hid!r}")

    def file(self, hid: str, stem: str) -> tuple[Path, dict]:
        item = self.get(hid)
        f = item["files"].get(stem)
        if not f:
            raise KeyError(f"history item {hid!r} has no file {stem!r}")
        return self._dir(hid) / f["file"], f

    def rename(self, hid: str, title: str) -> dict:
        from .voices import write_json_atomic
        with self._lock:
            item = self.get(hid)
            item["title"] = (title or item["title"]).strip()[:200]
            write_json_atomic(self._dir(hid) / "item.json", item)
            return item

    def delete(self, hid: str) -> None:
        d = self._dir(hid)
        if not (d / "item.json").exists():
            raise KeyError(f"no history item {hid!r}")
        shutil.rmtree(d, ignore_errors=True)

    def _dir(self, hid: str) -> Path:
        if not hid or "/" in hid or "\\" in hid or ".." in hid:
            raise KeyError(f"no history item {hid!r}")
        return self.root / hid
