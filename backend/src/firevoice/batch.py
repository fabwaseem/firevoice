"""Batch synthesis shared by the CLI (`firevoice batch`) and the HTTP server (`POST /v1/batch`).

lines: [{id, text, style?, voice?, pace?}]  ->  <out>/<id>.wav, <id>.words.json, manifest.json (merged per id)
Returns the manifest entries written for this call (in input order).

Lines are rendered concurrently (`parallel` requests in flight) so the engine pool stays saturated across
many short lines, not only within one long one.
"""
from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Optional

from . import audio as A


def save_result(res, out: Path, words: bool = True) -> None:
    A.write_audio(out, res.audio, res.sr)
    if words:
        out.with_suffix(".words.json").write_text(json.dumps([w.__dict__ for w in res.words], indent=1), encoding="utf-8")


def run_batch(synth, lines: list[dict], out_dir: str | Path, *, voice: str = "default", style: str = "conversational", pace: float = 1.0,
              seed: int = 1234, lufs: Optional[float] = -16.0, force: bool = False, log: Optional[Callable[[str], None]] = print,
              parallel: int = 2) -> list[dict]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else []
    say = log or (lambda s: None)
    lock = threading.Lock()
    results: dict[str, dict] = {}

    def one(ln: dict) -> None:
        nonlocal manifest
        dst = out / f"{ln['id']}.wav"
        if dst.exists() and not force:
            say(f"skip {dst}")
            prev = next((m for m in manifest if m.get("id") == ln["id"]), None)
            if prev:
                results[ln["id"]] = prev
            return
        r = synth.speak(ln["text"], voice=ln.get("voice", voice), style=ln.get("style") or style, pace=ln.get("pace", pace), seed=seed, lufs=lufs or None)
        save_result(r, dst)
        st = getattr(r, "stats", None)
        entry = {"id": ln["id"], "file": dst.name, "duration": round(r.duration, 3), "warnings": r.warnings,
                 "min_score": min((t.score for t in r.takes), default=1.0), "takes": len(r.takes), "attempts": sum(t.attempts for t in r.takes),
                 "cached_takes": sum(1 for t in r.takes if t.cached), "rtf": st.rtf if st else None, "seconds": round(st.wall_seconds, 2) if st else None}
        with lock:
            results[ln["id"]] = entry
            manifest = [m for m in manifest if m.get("id") != ln["id"]] + [entry]
            manifest_path.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
        say(f"{ln['id']}: {r.duration:.1f}s takes={len(r.takes)} cached={entry['cached_takes']} attempts={entry['attempts']} rtf={entry['rtf']} warnings={len(r.warnings)}")

    with ThreadPoolExecutor(max_workers=max(1, parallel)) as ex:
        list(ex.map(one, lines))
    return [results[ln["id"]] for ln in lines if ln["id"] in results]
