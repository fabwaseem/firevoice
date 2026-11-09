"""Local machine translation for dubbing: M2M100 (Meta, MIT), one model for any pair of 100 languages.

Two sizes: "fast" is facebook/m2m100_418M (about 2 GB, quick on the CPU), "better" is facebook/m2m100_1.2B (about 5 GB,
clearly more accurate, a few seconds per batch on the CPU; FIREVOICE_TRANSLATE_DEVICE=cuda puts it on the GPU).
FIREVOICE_TRANSLATOR sets the default (a size or any M2M100 checkpoint). Nothing leaves the machine.
"""
from __future__ import annotations

import os
import threading
from typing import Callable, Optional

SIZES = {"fast": "facebook/m2m100_418M", "better": "facebook/m2m100_1.2B"}
MODEL = SIZES.get(os.environ.get("FIREVOICE_TRANSLATOR", "fast"), os.environ.get("FIREVOICE_TRANSLATOR", SIZES["fast"]))

# M2M100's languages (ISO 639-1 where one exists)
LANGS = ("af am ar ast az ba be bg bn br bs ca ceb cs cy da de el en es et fa ff fi fr fy ga gd gl gu ha he hi hr ht hu hy id ig "
         "ilo is it ja jv ka kk km kn ko lb lg ln lo lt lv mg mk ml mn mr ms my ne nl no ns oc or pa pl ps pt ro ru sd si sk sl so "
         "sq sr ss su sv sw ta th tl tn tr uk ur uz vi wo xh yi yo zh zu").split()

_lock = threading.Lock()
_models: dict = {}


def supported(lang: str) -> bool:
    return (lang or "").lower().split("-")[0] in LANGS


def resolve(model: Optional[str]) -> str:
    """A size ("fast", "better") or a checkpoint name -> the checkpoint."""
    return SIZES.get(model or "", model or MODEL)


def _load(model: str):
    with _lock:
        if model not in _models:
            import torch
            from transformers import M2M100ForConditionalGeneration, M2M100Tokenizer
            dev = os.environ.get("FIREVOICE_TRANSLATE_DEVICE", "cpu")
            if dev == "cuda" and not torch.cuda.is_available():
                dev = "cpu"
            if len(_models) >= 1:          # one model in memory at a time (they are 2-5 GB)
                _models.clear()
            tok = M2M100Tokenizer.from_pretrained(model)
            m = M2M100ForConditionalGeneration.from_pretrained(model).eval().to(dev)
            _models[model] = (tok, m, torch, dev)
        return _models[model]


def translate(texts: list[str], source: str, target: str, progress: Optional[Callable[[int, int], None]] = None,
              batch: int = 8, model: Optional[str] = None) -> list[str]:
    """Translate each text from `source` to `target` (ISO codes). Empty texts stay empty."""
    src, tgt = source.lower().split("-")[0], target.lower().split("-")[0]
    for code in (src, tgt):
        if code not in LANGS:
            raise ValueError(f"translation does not support {code!r}")
    out = list(texts)
    if src == tgt:
        return out
    todo = [i for i, t in enumerate(texts) if t and t.strip()]
    tok, m, torch, dev = _load(resolve(model))
    for k in range(0, len(todo), batch):
        idx = todo[k:k + batch]
        with _lock, torch.inference_mode():
            tok.src_lang = src
            enc = tok([texts[i] for i in idx], return_tensors="pt", padding=True, truncation=True, max_length=400).to(dev)
            gen = m.generate(**enc, forced_bos_token_id=tok.get_lang_id(tgt), num_beams=4, max_new_tokens=400)
            for i, t in zip(idx, tok.batch_decode(gen, skip_special_tokens=True)):
                out[i] = t.strip()
        if progress:
            progress(min(k + batch, len(todo)), len(todo))
    return out
