"""Kept renders: every take of every passage, so you can compare, swap, re-take and lock passages after a render.

A render made with keep_takes is stored in FIREVOICE_HOME/takes/<id>/:
  render.json          the request, the timeline (passages, pauses, gaps) and each passage's takes with their QA
  c003_t1.flac         take 1 of passage 3, finished as heard (24-bit FLAC)

The stitched audio is rebuilt from the chosen take of each passage on demand, with the same studio chain as the
original render, so swapping a take never touches the other passages.
"""
from __future__ import annotations

import difflib
import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf

from . import audio as A

WORD = re.compile(r"[a-z0-9']+")


def qa_words(asked: str, heard: str) -> dict:
    """What the speech check heard against what was asked, word by word.
    -> {"words": [{"text", "status": ok|missed|changed, "heard"?}], "extra": [words heard but not asked], "match": 0..1}"""
    words = asked.split()
    keys = [" ".join(WORD.findall(w.lower())) for w in words]
    heard_words = heard.split()
    hk = [" ".join(WORD.findall(w.lower())) for w in heard_words]
    out = [{"text": w, "status": "ok"} for w in words]
    extra = []
    sm = difflib.SequenceMatcher(None, keys, hk, autojunk=False)
    from .asr import canon
    for op, a0, a1, b0, b1 in sm.get_opcodes():
        if op == "equal":
            continue
        if op == "replace" and "".join(canon(" ".join(words[a0:a1]))) == "".join(canon(" ".join(heard_words[b0:b1]))):
            continue     # the same words written differently: "Fire Voice" / "FireVoice", "forty two" / "42"
        if op in ("replace", "delete"):
            for k in range(a0, a1):
                if not keys[k]:
                    continue     # punctuation only
                if op == "replace" and b0 + (k - a0) < b1:
                    out[k] = {"text": words[k], "status": "changed", "heard": heard_words[b0 + (k - a0)]}
                else:
                    out[k] = {"text": words[k], "status": "missed"}
            if op == "replace" and (b1 - b0) > (a1 - a0):
                extra += heard_words[b0 + (a1 - a0): b1]
        elif op == "insert":
            extra += heard_words[b0:b1]
    scored = [w for w, k in zip(out, keys) if k]
    ok = sum(1 for w in scored if w["status"] == "ok")
    return {"words": out, "extra": [w for w in extra if WORD.search(w.lower())], "match": round(ok / max(1, len(scored)), 3)}


class RenderStore:
    def __init__(self, root: Path, keep: Optional[int] = None):
        self.root = Path(root)
        self.keep = keep
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ write
    def save(self, result, request: dict, engine: str, *, lufs: Optional[float], lead_ms: int, tail_ms: int, title: str = "") -> str:
        rid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        d = self.root / rid
        d.mkdir(parents=True, exist_ok=True)
        chunks = []
        for c in result.chunks:
            takes = []
            for n, t in enumerate(c["takes"], 1):
                takes.append(self._write_take(d, c["index"], n, t, result.sr, c["text"]))
            chunks.append({k: c[k] for k in ("index", "text", "style", "pace", "seed", "cuts", "asr")} | {
                "takes": takes, "chosen": takes[c["chosen"]]["n"] if takes else None, "locked": False})
        meta = {"id": rid, "created": time.time(), "title": title or _title(request.get("text", "")), "engine": engine, "sample_rate": result.sr,
                "request": request, "lufs": lufs, "lead_ms": lead_ms, "tail_ms": tail_ms, "plan": result.plan, "chunks": chunks}
        self._write_meta(d, meta)
        self._prune()
        return rid

    def _write_take(self, d: Path, index: int, n: int, t: dict, sr: int, asked: str) -> dict:
        name = f"c{index:03d}_t{n}.flac"
        sf.write(str(d / name), np.asarray(t["audio"], dtype=np.float32), sr, subtype="PCM_24", format="FLAC")
        return {"n": n, "file": name, "seed": t["seed"], "score": t["score"], "validated": t["validated"], "reasons": t["reasons"],
                "said": t["said"], "duration": round(len(t["audio"]) / sr, 3), "created": time.time(),
                "words": [{"text": w.text, "start": round(w.start, 3), "end": round(w.end, 3)} for w in t["words"]],
                "qa": qa_words(asked, t["said"]) if t["said"] else None}

    def add_take(self, rid: str, index: int, take: dict, *, choose: bool = True, text: Optional[str] = None,
                 edit: Optional[dict] = None) -> dict:
        """Store a new take of a passage. `text` (a word edit) becomes the passage's text from now on; earlier takes
        keep the text they said in their own `text`."""
        with self._lock:
            meta = self.get(rid)
            ch = self._chunk(meta, index)
            if text is not None and text != ch["text"]:
                for t in ch["takes"]:
                    t.setdefault("text", ch["text"])
                ch["text"] = text
            n = max((t["n"] for t in ch["takes"]), default=0) + 1
            rec = self._write_take(self.root / rid, index, n, take, meta["sample_rate"], ch["text"])
            rec["text"] = ch["text"]
            if edit:
                rec["edit"] = edit
            ch["takes"].append(rec)
            if choose and not ch.get("locked"):
                ch["chosen"] = n
            self._write_meta(self.root / rid, meta)
            return ch

    def choose(self, rid: str, index: int, n: int) -> dict:
        with self._lock:
            meta = self.get(rid)
            ch = self._chunk(meta, index)
            if not any(t["n"] == n for t in ch["takes"]):
                raise KeyError(f"passage {index} has no take {n}")
            ch["chosen"] = n
            self._write_meta(self.root / rid, meta)
            return ch

    def lock(self, rid: str, index: int, locked: bool) -> dict:
        with self._lock:
            meta = self.get(rid)
            ch = self._chunk(meta, index)
            ch["locked"] = bool(locked)
            self._write_meta(self.root / rid, meta)
            return ch

    def pin(self, rid: str, owner: Optional[str]) -> None:
        """A pinned render belongs to something else (a project paragraph) and is never pruned."""
        with self._lock:
            meta = self.get(rid)
            meta["pinned"] = owner
            self._write_meta(self.root / rid, meta)

    def delete(self, rid: str) -> None:
        d = self._dir(rid)
        shutil.rmtree(d, ignore_errors=True)

    # ------------------------------------------------------------------ read
    def list(self, limit: int = 50) -> list[dict]:
        out = []
        for f in sorted(self.root.glob("*/render.json"), reverse=True):
            if len(out) >= limit:
                break
            try:
                m = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            if m.get("pinned"):
                continue          # a project paragraph: listed with its project
            out.append({"id": m["id"], "created": m["created"], "title": m.get("title", ""), "engine": m["engine"],
                        "voice": m["request"].get("voice"), "style": m["request"].get("style"), "passages": len(m["chunks"]),
                        "takes": sum(len(c["takes"]) for c in m["chunks"]), "flagged": sum(1 for c in m["chunks"] if _flagged(c)),
                        "duration": round(sum(next((t.get("duration") or 0 for t in c["takes"] if t["n"] == c.get("chosen")), 0)
                                              for c in m["chunks"]), 2)})
        return out

    def get(self, rid: str) -> dict:
        f = self._dir(rid) / "render.json"
        if not f.exists():
            raise KeyError(f"no kept render {rid!r}")
        return json.loads(f.read_text(encoding="utf-8"))

    def take_path(self, rid: str, index: int, n: int) -> Path:
        ch = self._chunk(self.get(rid), index)
        t = next((t for t in ch["takes"] if t["n"] == n), None)
        if t is None:
            raise KeyError(f"passage {index} has no take {n}")
        return self._dir(rid) / t["file"]

    def stitch(self, rid: str) -> tuple[np.ndarray, int, list[dict]]:
        """The chosen take of every passage on the original timeline, through the original studio chain.
        -> (audio, sample rate, words with absolute times)"""
        meta = self.get(rid)
        sr = meta["sample_rate"]
        d = self._dir(rid)
        by_index = {c["index"]: c for c in meta["chunks"]}
        parts = [A.silence(meta["lead_ms"], sr)]
        t = meta["lead_ms"] / 1000.0
        words = []
        for item in meta["plan"]:
            if "pause" in item:
                parts.append(A.silence(item["pause"], sr))
                t += item["pause"] / 1000.0
                continue
            ch = by_index[item["chunk"]]
            take = next(x for x in ch["takes"] if x["n"] == ch["chosen"])
            a, _ = sf.read(str(d / take["file"]), dtype="float32", always_2d=False)
            words += [{"text": w["text"], "start": round(t + w["start"], 3), "end": round(t + w["end"], 3)} for w in take["words"]]
            parts.append(a)
            t += len(a) / sr
            if item.get("gap"):
                parts.append(A.silence(item["gap"], sr))
                t += item["gap"] / 1000.0
        parts.append(A.silence(meta["tail_ms"], sr))
        out = np.concatenate(parts).astype(np.float32)
        if meta.get("lufs") is not None and len(out) > sr // 10:
            out = A.studio_chain(out, sr, meta["lufs"])
        return out, sr, words

    def view(self, rid: str) -> dict:
        """render.json plus each passage's QA flag, for clients."""
        meta = self.get(rid)
        for c in meta["chunks"]:
            c["flagged"] = _flagged(c)
        meta["flagged"] = sum(1 for c in meta["chunks"] if c["flagged"])
        return meta

    # ------------------------------------------------------------------ internals
    def _dir(self, rid: str) -> Path:
        if not re.fullmatch(r"[0-9A-Za-z_-]{6,64}", rid or ""):
            raise KeyError(f"no kept render {rid!r}")
        return self.root / rid

    @staticmethod
    def _chunk(meta: dict, index: int) -> dict:
        ch = next((c for c in meta["chunks"] if c["index"] == index), None)
        if ch is None:
            raise KeyError(f"render {meta['id']} has no passage {index}")
        return ch

    @staticmethod
    def _write_meta(d: Path, meta: dict) -> None:
        from .voices import write_json_atomic
        write_json_atomic(d / "render.json", meta)

    def _prune(self) -> None:
        """With a `keep` limit, keep the newest `keep` renders (pinned and locked ones never count or go). Without one
        (the default) nothing is ever removed: renders are history, deleted only by the user."""
        if not self.keep:
            return
        free = []
        for p in sorted((p for p in self.root.glob("*") if (p / "render.json").exists()), reverse=True):
            try:
                m = json.loads((p / "render.json").read_text(encoding="utf-8"))
            except Exception:
                continue
            if m.get("pinned") or any(c.get("locked") for c in m.get("chunks", [])):
                continue
            free.append(p)
        for p in free[self.keep:]:
            shutil.rmtree(p, ignore_errors=True)


def _flagged(c: dict) -> bool:
    """A passage worth a listen: its chosen take did not pass the speech check, or words were missed."""
    t = next((x for x in c["takes"] if x["n"] == c.get("chosen")), None)
    if t is None:
        return True
    qa = t.get("qa") or {}
    signal = any(str(r).startswith(("rate", "gap", "repeat", "error", "empty", "clip")) for r in t.get("reasons") or [])
    return signal or bool(qa and qa.get("match", 1) < 0.999)


def _title(text: str) -> str:
    t = re.sub(r"\[[^\]]*\]", "", text or "").strip()
    return (t[:60] + "...") if len(t) > 60 else t
