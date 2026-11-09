"""Shared harness for the engine bake-off runners.

Every runner is run with *its own* venv's python:

    <venv>/Scripts/python.exe -X utf8 bench/runners/run_<engine>.py --out bench/out/<engine> --ref bench/refs/libri_m.wav

and must:
  * load the model once (timed), warm up once (not scored),
  * synthesize every item in bench/texts.json, timing each call,
  * write <id>.wav at the engine's native sample rate plus meta.json.

The scorer (bench/score.py) then transcribes, measures speaker similarity, predicted MOS and speed.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
TAG_RE = re.compile(r"\[(laugh|chuckle|sigh|gasp|cough|clear throat|sniff|groan|giggle|hmm)\]", re.I)


def strip_tags(text: str) -> str:
    return re.sub(r"\s{2,}", " ", TAG_RE.sub(" ", text)).strip()


def parse_args(engine: str, extra=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog=f"bench-{engine}")
    p.add_argument("--texts", default=str(ROOT / "bench" / "texts.json"))
    p.add_argument("--out", default=str(ROOT / "bench" / "out" / engine))
    p.add_argument("--ref", default=str(ROOT / "bench" / "refs" / "libri_m.wav"), help="reference clip for cloning")
    p.add_argument("--ref-text", default=None, help="transcript of --ref (defaults to the .txt beside it)")
    p.add_argument("--mode", default="clone", help="clone | design | preset (engine-specific)")
    p.add_argument("--voice-desc", default="A warm, confident adult male narrator with a clear, friendly, natural delivery.")
    p.add_argument("--only", default=None, help="comma-separated item ids")
    p.add_argument("--seed", type=int, default=1234)
    p.add_argument("--repeat", type=int, default=1, help="generate each item N times (speed stability)")
    if extra:
        extra(p)
    a = p.parse_args()
    if a.ref_text is None:
        t = Path(a.ref).with_suffix(".txt")
        a.ref_text = t.read_text(encoding="utf-8").strip() if t.exists() else ""
    return a


def load_items(args) -> list[dict]:
    items = json.loads(Path(args.texts).read_text(encoding="utf-8"))["items"]
    if args.only:
        keep = set(args.only.split(","))
        items = [i for i in items if i["id"] in keep]
    return items


def vram_peak_gb() -> float:
    try:
        import torch
        if torch.cuda.is_available():
            return round(torch.cuda.max_memory_allocated() / 1e9, 2)
    except Exception:
        pass
    return 0.0


def vram_reset() -> None:
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except Exception:
        pass


def seed_all(seed: int) -> None:
    try:
        import torch
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except Exception:
        pass
    np.random.seed(seed % (2**32 - 1))


def to_mono_f32(a) -> np.ndarray:
    try:
        import torch
        if isinstance(a, torch.Tensor):
            a = a.detach().float().cpu().numpy()
    except Exception:
        pass
    a = np.asarray(a, dtype=np.float32)
    if a.ndim > 1:
        a = a.squeeze()
        if a.ndim > 1:
            a = a.mean(axis=0) if a.shape[0] < a.shape[1] else a.mean(axis=1)
    return a


def run(engine: str, args, load_fn, synth_fn, *, supports_tags: bool = False, notes: str = "") -> None:
    """load_fn() -> (model, sr); synth_fn(model, text, item) -> np.ndarray (mono float, at sr)."""
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    items = load_items(args)
    print(f"[{engine}] loading...", flush=True)
    vram_reset()
    t0 = time.perf_counter()
    model, sr = load_fn()
    load_s = time.perf_counter() - t0
    load_vram = vram_peak_gb()
    print(f"[{engine}] loaded in {load_s:.1f}s, vram {load_vram} GB, sr {sr}", flush=True)
    # warm-up (cuDNN autotune, compile caches): not scored
    try:
        seed_all(args.seed)
        synth_fn(model, "This is a short warm up sentence to prime the engine.", {"id": "warmup", "style": "neutral"})
    except Exception as e:  # a warm-up failure is reported but does not stop the run
        print(f"[{engine}] warm-up failed: {e}", flush=True)
    meta = {"engine": engine, "mode": args.mode, "ref": args.ref, "sr": sr, "load_seconds": round(load_s, 2),
            "load_vram_gb": load_vram, "notes": notes, "items": []}
    for it in items:
        text = it["text"] if supports_tags else strip_tags(it["text"])
        for rep in range(args.repeat):
            vram_reset()
            seed_all(args.seed + rep)
            t0 = time.perf_counter()
            err = None
            try:
                audio = to_mono_f32(synth_fn(model, text, it))
            except Exception as e:
                audio, err = np.zeros(0, np.float32), f"{type(e).__name__}: {e}"
            wall = time.perf_counter() - t0
            dur = len(audio) / sr if sr else 0.0
            name = it["id"] if args.repeat == 1 else f"{it['id']}_{rep}"
            if len(audio):
                peak = float(np.abs(audio).max())
                if peak > 1.0:
                    audio = audio / peak * 0.99
                sf.write(str(out / f"{name}.wav"), audio, sr, subtype="PCM_16")
            entry = {"id": name, "text": text, "style": it.get("style"), "seconds": round(wall, 3), "audio_seconds": round(dur, 3),
                     "rtf": round(wall / dur, 3) if dur > 0 else None, "peak_vram_gb": vram_peak_gb(), "error": err}
            meta["items"].append(entry)
            print(f"[{engine}] {name:10} {wall:6.2f}s for {dur:5.1f}s audio  rtf={entry['rtf']}  vram={entry['peak_vram_gb']}GB" + (f"  ERROR {err}" if err else ""), flush=True)
    (out / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(f"[{engine}] done -> {out}", flush=True)
