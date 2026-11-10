"""Projects: long-form scripts (audiobooks, courses, video series) as chapters of paragraphs.

A project lives in FIREVOICE_HOME/projects/<id>/project.json, a plain JSON file you can read, diff and keep in git:

  {"id", "title", "created", "updated",
   "defaults": {any TTS request field: engine, voice, style, pace, lufs, dictionary...,
                "paragraph_gap_ms": 700, "chapter_gap_ms": 2500},
   "chapters": [{"id", "title", "paragraphs": [{"id", "text", "voice"?, "style"?, "pace"?, "locked",
                                                  "render": {"id", "key", "duration", "at"} | null}]}]}

Each paragraph renders as a kept render (every take, speech check, re-take, lock: see takestore), pinned to the
project so it is never pruned. A paragraph's status follows from its render:
  draft      never rendered
  rendered   rendered with exactly the current text and settings
  stale      the text or a setting changed since (re-render it)
  locked     rendered and locked: "render stale" leaves it alone
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import numpy as np

# fields of a paragraph that override the project defaults
PARA_FIELDS = ("voice", "style", "pace", "engine", "instruct", "language")
# project defaults that are not TTS request fields
LAYOUT_FIELDS = {"paragraph_gap_ms": 700, "chapter_gap_ms": 2500, "chapter_lead_ms": 500}


def _id() -> str:
    return uuid.uuid4().hex[:10]


def parse_text(text: str) -> list[dict]:
    """Chapters from a heading line ("# Title", "Chapter 3", "CHAPTER III: The Storm"); paragraphs from blank lines.
    Text before the first heading becomes an untitled first chapter."""
    head = re.compile(r"^\s*(?:#{1,3}\s+(?P<md>.+)|(?P<ch>(?:chapter|part)\s+[\w.-]+.*))\s*$", re.IGNORECASE)
    chapters: list[dict] = []
    cur: Optional[dict] = None
    buf: list[str] = []

    def flush():
        nonlocal buf
        para = " ".join(x.strip() for x in buf if x.strip())
        if para:
            if cur is None:
                chapters.append({"id": _id(), "title": "Chapter 1", "paragraphs": []})
                _set_cur(chapters[-1])
            chapters[-1]["paragraphs"].append({"id": _id(), "text": para, "locked": False, "render": None})
        buf = []

    def _set_cur(c):
        nonlocal cur
        cur = c
    for line in (text or "").replace("\r\n", "\n").split("\n"):
        m = head.match(line)
        if m and len(line.strip()) <= 120:
            flush()
            title = (m.group("md") or m.group("ch") or "").strip()
            chapters.append({"id": _id(), "title": title, "paragraphs": []})
            _set_cur(chapters[-1])
        elif not line.strip():
            flush()
        else:
            buf.append(line)
    flush()
    return chapters


class ProjectStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ files
    def _dir(self, pid: str) -> Path:
        if not re.fullmatch(r"[0-9a-z]{6,40}", pid or ""):
            raise KeyError(f"no project {pid!r}")
        return self.root / pid

    def get(self, pid: str) -> dict:
        f = self._dir(pid) / "project.json"
        if not f.exists():
            raise KeyError(f"no project {pid!r}")
        return json.loads(f.read_text(encoding="utf-8"))

    def save(self, p: dict) -> dict:
        from .voices import write_json_atomic
        p["updated"] = time.time()
        d = self._dir(p["id"])
        d.mkdir(parents=True, exist_ok=True)
        write_json_atomic(d / "project.json", p)
        return p

    def list(self) -> list[dict]:
        out = []
        for f in sorted(self.root.glob("*/project.json")):
            try:
                out.append(json.loads(f.read_text(encoding="utf-8")))
            except Exception:
                continue
        return sorted(out, key=lambda p: -p.get("updated", 0))

    def create(self, title: str, text: str = "", defaults: Optional[dict] = None) -> dict:
        now = time.time()
        p = {"id": uuid.uuid4().hex[:12], "title": (title or "Untitled project").strip()[:200], "created": now, "updated": now,
             "defaults": {**LAYOUT_FIELDS, **(defaults or {})}, "chapters": parse_text(text) or [{"id": _id(), "title": "Chapter 1", "paragraphs": []}]}
        with self._lock:
            return self.save(p)

    def delete(self, pid: str) -> None:
        shutil.rmtree(self._dir(pid), ignore_errors=True)

    # ------------------------------------------------------------------ editing
    def update(self, pid: str, *, title: Optional[str] = None, defaults: Optional[dict] = None, chapters: Optional[list] = None) -> tuple[dict, list[str]]:
        """Apply an edit. `chapters` replaces the structure; paragraphs keep their render (and so their status) when
        they keep their id. -> (project, render ids no longer used by any paragraph)."""
        with self._lock:
            p = self.get(pid)
            if title is not None:
                p["title"] = str(title).strip()[:200] or p["title"]
            if defaults is not None:
                if not isinstance(defaults, dict):
                    raise ValueError("defaults must be an object")
                p["defaults"] = {**LAYOUT_FIELDS, **defaults}
            dropped: list[str] = []
            if chapters is not None:
                old = {para["id"]: para for ch in p["chapters"] for para in ch["paragraphs"]}
                new_chapters = []
                for ch in chapters:
                    if not isinstance(ch, dict):
                        raise ValueError("each chapter must be an object with a title and paragraphs")
                    paras = []
                    for para in ch.get("paragraphs") or []:
                        if not isinstance(para, dict):
                            raise ValueError("each paragraph must be an object with text")
                        pid_ = str(para.get("id") or _id())
                        prev = old.get(pid_, {})
                        item = {"id": pid_, "text": str(para.get("text") or ""), "locked": bool(para.get("locked", prev.get("locked", False))),
                                "render": prev.get("render")}
                        for k in PARA_FIELDS:
                            v = para.get(k, prev.get(k)) if k in para or k in prev else None
                            if v not in (None, ""):
                                item[k] = v
                        paras.append(item)
                    new_chapters.append({"id": str(ch.get("id") or _id()), "title": str(ch.get("title") or "Untitled chapter")[:200], "paragraphs": paras})
                kept = {para["render"]["id"] for ch in new_chapters for para in ch["paragraphs"] if para.get("render")}
                dropped = [para["render"]["id"] for para in old.values() if para.get("render") and para["render"]["id"] not in kept]
                p["chapters"] = new_chapters
            return self.save(p), dropped

    def set_render(self, pid: str, para_id: str, render: Optional[dict]) -> tuple[dict, Optional[str]]:
        """Point a paragraph at a new render. -> (project, the render it used before, if any)."""
        with self._lock:
            p = self.get(pid)
            para = find_para(p, para_id)
            old = (para.get("render") or {}).get("id")
            para["render"] = render
            return self.save(p), old

    def set_lock(self, pid: str, para_id: str, locked: bool) -> dict:
        with self._lock:
            p = self.get(pid)
            find_para(p, para_id)["locked"] = bool(locked)
            return self.save(p)


# ---------------------------------------------------------------------- helpers
def find_para(p: dict, para_id: str) -> dict:
    for ch in p["chapters"]:
        for para in ch["paragraphs"]:
            if para["id"] == para_id:
                return para
    raise KeyError(f"project {p['id']} has no paragraph {para_id!r}")


def find_chapter(p: dict, chapter_id: str) -> dict:
    for ch in p["chapters"]:
        if ch["id"] == chapter_id:
            return ch
    raise KeyError(f"project {p['id']} has no chapter {chapter_id!r}")


def request_for(p: dict, para: dict) -> dict:
    """The TTS request a paragraph renders with: project defaults, then the paragraph's own settings."""
    d = {k: v for k, v in (p.get("defaults") or {}).items() if k not in LAYOUT_FIELDS}
    for k in PARA_FIELDS:
        if para.get(k) not in (None, ""):
            d[k] = para[k]
    d["text"] = para["text"]
    d["keep_takes"] = True
    return d


def render_key(req: dict) -> str:
    return hashlib.sha1(json.dumps(req, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


def status(p: dict, para: dict) -> str:
    r = para.get("render")
    if not r:
        return "draft"
    if r.get("key") != render_key(request_for(p, para)):
        return "stale"
    return "locked" if para.get("locked") else "rendered"


def view(p: dict) -> dict:
    """The project with each paragraph's status and per-chapter and total counts, for clients."""
    out = json.loads(json.dumps(p))
    total = {"draft": 0, "rendered": 0, "stale": 0, "locked": 0}
    dur = 0.0
    for ch in out["chapters"]:
        counts = {"draft": 0, "rendered": 0, "stale": 0, "locked": 0}
        cdur = 0.0
        for para in ch["paragraphs"]:
            para["status"] = status(p, find_para(p, para["id"]))
            counts[para["status"]] += 1
            if para.get("render"):
                cdur += para["render"].get("duration") or 0
        ch["counts"], ch["duration"] = counts, round(cdur, 2)
        for k in total:
            total[k] += counts[k]
        dur += cdur
    out["counts"], out["duration"] = total, round(dur, 2)
    out["paragraphs"] = sum(len(ch["paragraphs"]) for ch in out["chapters"])
    out["words"] = sum(len(para["text"].split()) for ch in out["chapters"] for para in ch["paragraphs"])
    return out


def summary(p: dict) -> dict:
    v = view(p)
    return {k: v[k] for k in ("id", "title", "created", "updated", "counts", "duration", "paragraphs", "words")} | {"chapters": len(v["chapters"])}


# ---------------------------------------------------------------------- audiobook check (ACX-style)
def audiobook_check(a: np.ndarray, sr: int) -> dict:
    """The usual audiobook submission limits: RMS -23 to -18 dBFS, peaks at most -3 dBFS, noise floor at most
    -60 dBFS (quietest half second), 0.5-1 s of quiet at the head and 1-5 s at the tail."""
    if len(a) < sr // 2:
        return {"pass": False, "checks": [], "note": "too short to check"}
    db = lambda x: float(20 * np.log10(max(x, 1e-9)))
    rms = db(float(np.sqrt(np.mean(a.astype(np.float64) ** 2))))
    peak = db(float(np.max(np.abs(a))))
    win = sr // 2
    n = len(a) // win
    blocks = np.sqrt((a[: n * win].astype(np.float64).reshape(n, win) ** 2).mean(axis=1) + 1e-18) if n else np.array([1e-9])
    floor = db(float(blocks.min()))
    frame = max(1, sr // 100)
    m = len(a) // frame
    lv = 20 * np.log10(np.sqrt((a[: m * frame].astype(np.float64).reshape(m, frame) ** 2).mean(axis=1)) + 1e-9)
    loud = np.where(lv > rms - 25)[0]
    head = (loud[0] * frame / sr) if len(loud) else 0.0
    tail = ((m - 1 - loud[-1]) * frame / sr) if len(loud) else 0.0
    checks = [
        {"name": "Loudness (RMS)", "value": round(rms, 1), "unit": "dBFS", "target": "-23 to -18", "ok": -23 <= rms <= -18},
        {"name": "Peak", "value": round(peak, 1), "unit": "dBFS", "target": "-3 or lower", "ok": peak <= -3.0},
        {"name": "Noise floor", "value": round(floor, 1), "unit": "dBFS", "target": "-60 or lower", "ok": floor <= -60},
        {"name": "Quiet at the start", "value": round(head, 2), "unit": "s", "target": "0.5 to 1", "ok": 0.5 <= head <= 1.0},
        {"name": "Quiet at the end", "value": round(tail, 2), "unit": "s", "target": "1 to 5", "ok": 1.0 <= tail <= 5.0},
    ]
    for c in checks:
        c["ok"], c["value"] = bool(c["ok"]), float(c["value"])
    return {"pass": all(c["ok"] for c in checks), "checks": checks, "duration": round(len(a) / sr, 2)}


def master_audiobook(a: np.ndarray, sr: int) -> np.ndarray:
    """Bring a chapter inside the audiobook limits: RMS to -20 dBFS, peaks bent under -3.2 dBFS."""
    from . import audio as A
    rms = float(np.sqrt(np.mean(a.astype(np.float64) ** 2))) or 1e-9
    g = min(8.0, 10 ** (-20 / 20) / rms)
    ceiling = 10 ** (-3.2 / 20)
    return A.soft_limit(a * g, knee=ceiling * 0.8, ceiling=ceiling)


def m4b_bytes(a: np.ndarray, sr: int, chapters: list[tuple[str, float, float]], title: str, bitrate: str = "96k") -> bytes:
    """An M4B audiobook with chapter marks. `chapters`: (title, start s, end s)."""
    import os
    import tempfile

    import soundfile as sf

    from . import audio as A
    d = Path(tempfile.mkdtemp(prefix="fv-m4b-"))
    try:
        wav, meta, out = d / "in.wav", d / "meta.txt", d / "out.m4b"
        sf.write(str(wav), np.clip(a, -1, 1), sr, subtype="PCM_16")
        esc = lambda s: re.sub(r"([=;#\\\n])", r"\\\1", s)
        lines = [";FFMETADATA1", f"title={esc(title)}", "genre=Audiobook"]
        for name, start, end in chapters:
            lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={int(start * 1000)}", f"END={int(end * 1000)}", f"title={esc(name)}"]
        meta.write_text("\n".join(lines) + "\n", encoding="utf-8")
        A._run([A._ffmpeg(), "-y", "-v", "error", "-i", str(wav), "-i", str(meta), "-map_metadata", "1", "-map_chapters", "1",
                "-c:a", "aac", "-b:a", bitrate, "-f", "ipod", "-movflags", "+faststart", str(out)], b"")
        return out.read_bytes()
    finally:
        shutil.rmtree(d, ignore_errors=True)
        _ = os
