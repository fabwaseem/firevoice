"""Harvest reference voices from open speech datasets (Hugging Face parquet shards with an `audio` column).

For every speaker in the shard(s): keep utterances of 7-14 s, measure a noise-floor SNR estimate, clipping,
speaking rate and pitch (median F0 -> gender guess), then register the best clip as a voice with full
provenance (dataset, license, speaker id, utterance id, transcript). Stitches two shorter utterances of the
same speaker when no single one is long enough.

    firevoice voices harvest --dataset libritts_r --shards ".downloads/libritts_r/data/test.clean/*.parquet" --max 12 --prefix lib
"""
from __future__ import annotations

import glob
import io
import json
import re
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf

from . import audio as A

# dataset -> (speaker column, text column, style column, license, human-readable source)
DATASETS = {
    "libritts_r": ("speaker_id", "text_normalized", None, "CC-BY-4.0", "LibriTTS-R (LibriVox readers, restored)"),
    "hifi_tts": ("speaker", "text_normalized", None, "CC-BY-4.0", "Hi-Fi TTS (LibriVox audiobook narrators, 44.1 kHz)"),
    "expresso": ("speaker_id", "text", "style", "CC-BY-NC-4.0", "Expresso (Meta, expressive studio speech)"),
}


def _read_rows(path: str, cols: list[str]):
    import pyarrow.parquet as pq
    pf = pq.ParquetFile(path)
    names = set(pf.schema_arrow.names)
    want = [c for c in cols if c in names]
    for rg in range(pf.num_row_groups):
        for r in pf.read_row_group(rg, columns=want).to_pylist():
            yield r


def _audio(row) -> tuple[np.ndarray, int]:
    a = row["audio"]
    if isinstance(a, dict) and a.get("bytes"):
        data, sr = sf.read(io.BytesIO(a["bytes"]), dtype="float32")
    elif isinstance(a, dict) and a.get("array") is not None:
        data, sr = np.asarray(a["array"], dtype=np.float32), int(a["sampling_rate"])
    else:
        raise ValueError("unsupported audio cell")
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data.astype(np.float32), int(sr)


def quality(a: np.ndarray, sr: int) -> dict:
    frame = max(1, int(sr * 0.02))
    n = len(a) // frame
    rms = np.sqrt((a[: n * frame].reshape(n, frame) ** 2).mean(axis=1) + 1e-12)
    snr = float(20 * np.log10(np.percentile(rms, 90) / max(np.percentile(rms, 10), 1e-6)))
    return {"snr": round(snr, 1), "clip": float((np.abs(a) > 0.99).mean()), "peak": float(np.abs(a).max()), "dur": round(len(a) / sr, 2)}


def pitch(a: np.ndarray, sr: int) -> float:
    try:
        import librosa
        f0, _, _ = librosa.pyin(a[: sr * 12], fmin=60, fmax=400, sr=sr, frame_length=2048)
        f0 = f0[~np.isnan(f0)]
        return float(np.median(f0)) if len(f0) else 0.0
    except Exception:
        return 0.0


def gender_from_f0(f0: float) -> str:
    if f0 <= 0:
        return ""
    return "male" if f0 < 155 else "female" if f0 > 175 else "neutral"


# dataset style -> FireVoice styles it is a good reference for (Expresso naming)
STYLE_MAP = {
    "default": [], "essentials": None, "emphasis": ["dramatic"], "confused": ["curious"], "enunciated": ["explainer", "newscaster"],
    "happy": ["excited", "conversational", "podcast"], "laughing": ["excited", "sports"], "sad": ["sad", "reflective"],
    "whisper": ["asmr", "horror", "bedtime"], "angry": ["angry"], "calm": ["calm", "audiobook"], "fast": ["sports"], "projected": ["trailer"],
    "sarcastic": ["deadpan"], "awe": ["documentary"], "desire": ["asmr"], "sleepy": ["bedtime"], "nonverbal": None, "singing": None,
}


def _register_styled(best: dict, lib, prefix: str, source: str, license_: str, dataset: str, max_voices: int, log) -> list[dict]:
    """Expressive datasets: one voice per speaker (base = 'default' style) plus per-style reference clips."""
    by_spk: dict[str, dict[str, dict]] = {}
    for c in best.values():
        by_spk.setdefault(c["speaker"], {})[c["style"]] = c
    out = []
    for spk, styles in list(by_spk.items())[:max_voices]:
        base = styles.get("default") or max(styles.values(), key=lambda c: c["snr"])
        f0 = pitch(base["audio"], base["sr"])
        g = gender_from_f0(f0)
        name = f"{prefix}-{ {'male': 'm', 'female': 'f'}.get(g, 'x') }-{re.sub(r'[^a-z0-9]+', '', spk.lower())}"
        tmp = Path(lib.root) / "_harvest.wav"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(tmp), base["audio"] / (float(np.abs(base["audio"]).max()) or 1.0) * 0.9, base["sr"], subtype="PCM_16")
        meta = lib.add(name, tmp, consent=True, description=f"{g or 'adult'} studio speaker {spk} from {source}", gender=g, tags=[dataset, "expressive"],
                       source=f"{source}; speaker {spk}; utterance {base['id']}", license=license_, transcript=base["text"] or None, transcribe=not base["text"])
        added = []
        for st, c in styles.items():
            targets = STYLE_MAP.get(st, [st])
            if not targets:
                continue
            sf.write(str(tmp), c["audio"] / (float(np.abs(c["audio"]).max()) or 1.0) * 0.9, c["sr"], subtype="PCM_16")
            for t in targets:
                lib.add_style_ref(name, t, tmp, transcript=c["text"] or None, transcribe=not c["text"])
                added.append(f"{t}<-{st}")
        tmp.unlink(missing_ok=True)
        log(f"  + {name:22} {g or '?':7} f0={f0:.0f} snr={base['snr']} {base['dur']}s  style refs: {', '.join(added) or '-'}")
        meta["style_refs"] = added
        out.append(meta)
    return out


def harvest(dataset: str, shards: list[str], *, lib, max_voices: int = 12, prefix: str = "", min_s: float = 7.0, max_s: float = 14.0,
            min_snr: float = 28.0, per_gender: Optional[int] = None, styles: Optional[list[str]] = None, log=print) -> list[dict]:
    spk_col, txt_col, style_col, license_, source = DATASETS[dataset]
    best: dict[str, dict] = {}        # speaker -> best candidate
    shorts: dict[str, list] = {}      # speaker -> short clean utterances (for stitching)
    files = [f for pat in shards for f in sorted(glob.glob(pat))]
    if not files:
        raise FileNotFoundError(f"no shards match {shards}")
    for f in files:
        log(f"scanning {f}")
        for row in _read_rows(f, ["audio", spk_col, txt_col, style_col or spk_col, "id"]):
            style = str(row.get(style_col, "")) if style_col else ""
            if styles and style and style not in styles:
                continue
            key = f"{row[spk_col]}" + (f"-{style}" if style_col and style else "")
            a, sr = _audio(row)
            a = A.trim_silence(a, sr)
            q = quality(a, sr)
            if q["clip"] > 0 or q["snr"] < min_snr:
                continue
            text = (row.get(txt_col) or "").strip()
            cand = {"speaker": str(row[spk_col]), "style": style, "id": str(row.get("id", "")), "text": text, "audio": a, "sr": sr, **q}
            if q["dur"] < min_s:
                if q["dur"] >= 2.5:
                    shorts.setdefault(key, []).append(cand)
                continue
            if q["dur"] > max_s:
                continue
            if key not in best or q["snr"] > best[key]["snr"]:
                best[key] = cand
    # stitch two short utterances for speakers without a long enough clip
    for key, items in shorts.items():
        if key in best or len(items) < 2:
            continue
        items.sort(key=lambda c: -c["snr"])
        a_, b_ = items[0], items[1]
        if a_["sr"] != b_["sr"]:
            continue
        gap = np.zeros(int(a_["sr"] * 0.35), np.float32)
        joined = np.concatenate([a_["audio"], gap, b_["audio"]])
        if min_s <= len(joined) / a_["sr"] <= max_s + 2:
            best[key] = {**a_, "audio": joined, "text": f"{a_['text']} {b_['text']}", "id": f"{a_['id']}+{b_['id']}", **quality(joined, a_["sr"])}
    if style_col:
        return _register_styled(best, lib, prefix or dataset, source, license_, dataset, max_voices, log)
    log(f"{len(best)} speaker clips pass the bar; measuring pitch...")
    rows = []
    for key, c in best.items():
        c["f0"] = pitch(c["audio"], c["sr"])
        c["gender"] = gender_from_f0(c["f0"])
        rows.append(c)
    rows.sort(key=lambda c: -c["snr"])
    chosen: list[dict] = []
    counts = {"male": 0, "female": 0, "neutral": 0, "": 0}
    for c in rows:
        if len(chosen) >= max_voices:
            break
        if per_gender and counts.get(c["gender"], 0) >= per_gender:
            continue
        counts[c["gender"]] = counts.get(c["gender"], 0) + 1
        chosen.append(c)
    out = []
    for c in chosen:
        g = {"male": "m", "female": "f"}.get(c["gender"], "x")
        name = f"{prefix or dataset}-{g}-{re.sub(r'[^a-z0-9]+', '', c['speaker'].lower())}" + (f"-{c['style']}" if c["style"] else "")
        tmp = Path(lib.root) / "_harvest.wav"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(tmp), c["audio"] / (float(np.abs(c["audio"]).max()) or 1.0) * 0.9, c["sr"], subtype="PCM_16")
        desc = f"{c['gender'] or 'adult'} speaker {c['speaker']} from {source}" + (f", {c['style']} style" if c["style"] else "")
        meta = lib.add(name, tmp, consent=True, description=desc, gender=c["gender"], tags=[dataset] + ([c["style"]] if c["style"] else []),
                       source=f"{source}; speaker {c['speaker']}; utterance {c['id']}", license=license_, transcript=c["text"] or None, transcribe=not c["text"])
        meta.update({"snr": c["snr"], "f0": round(c["f0"]), "seconds": c["dur"]})
        tmp.unlink(missing_ok=True)
        log(f"  + {name:28} {c['gender'] or '?':7} f0={c['f0']:.0f}  snr={c['snr']}  {c['dur']}s  {c['text'][:60]!r}")
        out.append(meta)
    return out


# ---------------------------------------------------------------------------------------------------------------
# GLOBE V2: Common Voice English re-recorded through speech enhancement, with accent / gender / age labels (CC0).
# Clips are short (3-6 s), so two or three clean clips of the same speaker are stitched into one reference.

ACCENT_CODES = [
    ("united states", "us"), ("american", "us"), ("england", "uk"), ("british", "uk"), ("scottish", "sco"), ("scotland", "sco"),
    ("irish", "ie"), ("ireland", "ie"), ("welsh", "wal"), ("wales", "wal"), ("australia", "au"), ("new zealand", "nz"), ("canad", "ca"),
    ("south asia", "sas"), ("pakistan", "pk"), ("india", "in"), ("southern african", "za"), ("south africa", "za"), ("nigeria", "ng"),
    ("kenya", "ke"), ("west indies", "wi"), ("caribbean", "wi"), ("filipino", "ph"), ("philippin", "ph"), ("singapore", "sg"),
    ("malaysia", "my"), ("hong kong", "hk"), ("german", "de"), ("france", "fr"), ("french", "fr"), ("spanish", "es"), ("spain", "es"),
    ("latin", "la"), ("mexic", "mx"), ("brazil", "br"), ("italian", "it"), ("russian", "ru"), ("polish", "pl"), ("dutch", "nl"),
    ("chinese", "cn"), ("japanese", "jp"), ("korean", "kr"), ("arab", "ar"), ("turkish", "tr"), ("african", "af"),
]


def accent_code(accent: str) -> str:
    a = (accent or "").lower()
    for key, code in ACCENT_CODES:
        if key in a:
            return code
    w = re.sub(r"[^a-z]+", "", a.split(",")[0].split("(")[0])
    return w[:5] or "xx"


def _first_col(names: set, *cands: str) -> Optional[str]:
    return next((c for c in cands if c in names), None)


def harvest_globe(shards: list[str], *, lib, max_voices: int = 40, per_accent: int = 4, prefix: str = "glb", min_s: float = 7.0,
                  max_s: float = 16.0, min_snr: float = 30.0, accents: Optional[list[str]] = None, log=print) -> list[dict]:
    import pyarrow.parquet as pq
    files = [f for pat in shards for f in sorted(glob.glob(pat))]
    if not files:
        raise FileNotFoundError(f"no shards match {shards}")
    names = set(pq.ParquetFile(files[0]).schema_arrow.names)
    c_spk = _first_col(names, "speaker_id", "client_id", "speaker")
    c_txt = _first_col(names, "transcript", "sentence", "text")
    c_acc = _first_col(names, "accent", "accents")
    c_gen = _first_col(names, "gender")
    c_age = _first_col(names, "age")
    log(f"columns: speaker={c_spk} text={c_txt} accent={c_acc} gender={c_gen} age={c_age}")
    clips: dict[str, list[dict]] = {}
    info: dict[str, dict] = {}
    for f in files:
        log(f"scanning {f}")
        for row in _read_rows(f, [c for c in ["audio", c_spk, c_txt, c_acc, c_gen, c_age] if c]):
            spk = str(row[c_spk])
            acc = str(row.get(c_acc) or "")
            if accents and accent_code(acc) not in accents:
                continue
            if len(clips.get(spk, [])) >= 6:
                continue
            a, sr = _audio(row)
            a = A.trim_silence(a, sr)
            q = quality(a, sr)
            if q["clip"] > 0 or q["snr"] < min_snr or q["dur"] < 2.5:
                continue
            clips.setdefault(spk, []).append({"audio": a, "sr": sr, "text": (row.get(c_txt) or "").strip(), **q})
            info[spk] = {"accent": acc, "gender": str(row.get(c_gen) or "").lower(), "age": str(row.get(c_age) or "")}
    # one reference per speaker: best clips stitched until long enough
    cands = []
    for spk, cs in clips.items():
        cs.sort(key=lambda c: -c["snr"])
        parts, dur = [], 0.0
        for c in cs:
            if c["sr"] != cs[0]["sr"] or dur + c["dur"] > max_s:
                continue
            parts.append(c)
            dur += c["dur"] + 0.35
            if dur >= min_s + 1:
                break
        if dur < min_s:
            continue
        gap = np.zeros(int(parts[0]["sr"] * 0.35), np.float32)
        joined = np.concatenate([x for p in parts for x in (p["audio"], gap)][:-1])
        g = info[spk]["gender"]
        g = "male" if g.startswith("male") else "female" if g.startswith("female") else ""
        cands.append({"speaker": spk, "audio": joined, "sr": parts[0]["sr"], "text": " ".join(p["text"] for p in parts), "snr": min(p["snr"] for p in parts),
                      "dur": round(len(joined) / parts[0]["sr"], 2), "gender": g, "accent": info[spk]["accent"], "age": info[spk]["age"], "n": len(parts)})
    log(f"{len(cands)} speakers have a clean {min_s:.0f}+ s reference")
    # round-robin over accents (largest pools first), alternating gender, best SNR first
    by_acc: dict[str, list[dict]] = {}
    for c in sorted(cands, key=lambda c: -c["snr"]):
        by_acc.setdefault(accent_code(c["accent"]), []).append(c)
    order = sorted(by_acc, key=lambda k: -len(by_acc[k]))
    chosen, taken = [], {k: 0 for k in order}
    # alternate gender inside each accent, and start every other accent on the other gender so totals balance too
    want = {k: ("female" if i % 2 == 0 else "male") for i, k in enumerate(order)}
    while len(chosen) < max_voices:
        progressed = False
        for k in order:
            if len(chosen) >= max_voices or taken[k] >= per_accent or not by_acc[k]:
                continue
            pool = by_acc[k]
            pick = next((c for c in pool if c["gender"] == want[k]), pool[0])
            pool.remove(pick)
            chosen.append(pick)
            taken[k] += 1
            want[k] = "male" if want[k] == "female" else "female"
            progressed = True
        if not progressed:
            break
    out = []
    tmp = Path(lib.root) / "_harvest.wav"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    for c in chosen:
        code = accent_code(c["accent"])
        g = {"male": "m", "female": "f"}.get(c["gender"], "x")
        name = f"{prefix}-{g}-{code}-{re.sub(r'[^a-z0-9]+', '', c['speaker'].lower())[:6]}"
        sf.write(str(tmp), c["audio"] / (float(np.abs(c["audio"]).max()) or 1.0) * 0.9, c["sr"], subtype="PCM_16")
        desc = f"{c['gender'] or 'adult'} speaker, {c['accent'] or 'unknown'} accent" + (f", {c['age']}" if c["age"] else "")
        meta = lib.add(name, tmp, consent=True, description=desc, gender=c["gender"], tags=["globe_v2", f"accent:{code}"],
                       source=f"GLOBE V2 (Common Voice English, enhanced); speaker {c['speaker']}; {c['n']} clips stitched", license="CC0-1.0",
                       transcript=c["text"] or None, transcribe=not c["text"],
                       extra={"language": "en", "accent": c["accent"], "accent_code": code, "age": c["age"], "snr": c["snr"]})
        log(f"  + {name:30} {c['gender'] or '?':7} {c['accent'][:40]:40} snr={c['snr']} {c['dur']}s")
        out.append(meta)
    tmp.unlink(missing_ok=True)
    return out


# ---------------------------------------------------------------------------------------------------------------
# FLEURS / FLEURS-R: read Wikipedia sentences in 102 languages (CC-BY-4.0). Layout: <lang>/<split>.tsv plus
# <lang>/audio/<split>.tar.gz. There are no speaker ids, so distinct speakers are found by voice embedding.

def _fleurs_rows(lang_dir: Path, splits: list[str]):
    import csv
    import tarfile
    for split in splits:
        tsv = lang_dir / f"{split}.tsv"
        tar = lang_dir / "audio" / f"{split}.tar.gz"
        if not tsv.exists() or not tar.exists():
            continue
        meta = {}
        with open(tsv, encoding="utf-8") as fh:
            for r in csv.reader(fh, delimiter="\t", quoting=csv.QUOTE_NONE):
                if len(r) >= 7:
                    meta[r[1]] = {"sid": r[0], "raw": r[2], "text": r[3], "gender": r[6].lower()}
        with tarfile.open(tar, "r:gz") as tf:
            for m in tf:
                if not m.isfile():
                    continue
                base = Path(m.name).name
                if base not in meta:
                    continue
                fh = tf.extractfile(m)
                if fh is None:
                    continue
                data, sr = sf.read(io.BytesIO(fh.read()), dtype="float32")
                if data.ndim > 1:
                    data = data.mean(axis=1)
                yield {"file": base, "split": split, "audio": data, "sr": int(sr), **meta[base]}


def harvest_fleurs(lang_dir: str, *, lib, language: str, lang_name: str, max_voices: int = 12, prefix: str = "", min_s: float = 7.0,
                   max_s: float = 18.0, min_snr: float = 26.0, same_speaker: float = 0.80, splits: Optional[list[str]] = None,
                   source: str = "FLEURS-R (Google, restored)", log=print) -> list[dict]:
    from resemblyzer import VoiceEncoder, preprocess_wav
    enc = VoiceEncoder("cpu", verbose=False)
    d = Path(lang_dir)
    cands = []
    for r in _fleurs_rows(d, splits or ["dev", "test", "train"]):
        a = A.trim_silence(r["audio"], r["sr"])
        q = quality(a, r["sr"])
        # FLEURS-R is peak-normalised, so a few samples sit at full scale; only reject real clipping
        if q["clip"] > 1e-4 or q["snr"] < min_snr or not (min_s <= q["dur"] <= max_s):
            continue
        cands.append({**r, "audio": a, **q})
    log(f"{len(cands)} clean {min_s:.0f}-{max_s:.0f} s clips; separating speakers by voice embedding")
    cands.sort(key=lambda c: -c["snr"])
    chosen, embs = [], []
    counts = {"male": 0, "female": 0}
    cap = (max_voices + 1) // 2
    for c in cands:
        if len(chosen) >= max_voices:
            break
        g = c["gender"] if c["gender"] in ("male", "female") else gender_from_f0(pitch(c["audio"], c["sr"]))
        if g in counts and counts[g] >= cap:
            continue
        e = enc.embed_utterance(preprocess_wav(c["audio"], source_sr=c["sr"]))
        if any(float(np.dot(e, x)) >= same_speaker for x in embs):
            continue    # same person as a voice we already kept
        embs.append(e)
        counts[g] = counts.get(g, 0) + 1
        chosen.append({**c, "g": g})
    out = []
    tmp = Path(lib.root) / "_harvest.wav"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    n = {"m": 0, "f": 0, "x": 0}
    for c in chosen:
        g = {"male": "m", "female": "f"}.get(c["g"], "x")
        n[g] += 1
        name = f"{prefix or language}-{g}-{n[g]:02d}"
        sf.write(str(tmp), c["audio"] / (float(np.abs(c["audio"]).max()) or 1.0) * 0.9, c["sr"], subtype="PCM_16")
        meta = lib.add(name, tmp, consent=True, description=f"{c['g'] or 'adult'} native {lang_name} speaker", gender=c["g"], tags=["fleurs", f"lang:{language}"],
                       source=f"{source}; {lang_name}; {c['split']} {c['file']} (sentence {c['sid']})", license="CC-BY-4.0",
                       transcript=c["raw"] or c["text"] or None, transcribe=False,
                       extra={"language": language, "accent": f"native {lang_name}", "snr": c["snr"]})
        log(f"  + {name:14} {c['g'] or '?':7} snr={c['snr']} {c['dur']}s  {c['raw'][:50]}")
        out.append(meta)
    tmp.unlink(missing_ok=True)
    return out


# ---------------------------------------------------------------------------------------------------------------
# Common Voice (CC0): thousands of volunteer speakers per language with gender/age labels. Only the clips we need are
# fetched: the best-voted clips of the speakers with the most validated recordings. Microphones vary a lot, so the
# quality bar is the same SNR / clipping check as everywhere else, plus stitching 2-3 clips into one reference.

def harvest_commonvoice(cv_dir: str, *, lib, language: str, lang_name: str, repo: Optional[str] = None, max_voices: int = 10,
                        per_gender: Optional[int] = None, prefix: str = "", min_s: float = 7.0, max_s: float = 16.0, min_snr: float = 30.0,
                        candidates_per_gender: int = 24, clips_per_speaker: int = 5, same_speaker: float = 0.80, split: str = "validated",
                        log=print) -> list[dict]:
    """split="other" uses the not-yet-voted clips (many more speakers in partial re-uploads; the SNR bar still applies)."""
    import csv
    import shutil
    from concurrent.futures import ThreadPoolExecutor
    d = Path(cv_dir)
    tsv = d / f"{split}.tsv"
    if not tsv.exists() and repo:
        from huggingface_hub import hf_hub_download
        hf_hub_download(repo, f"{split}.tsv", repo_type="dataset", local_dir=str(d))
    min_up = 2 if split == "validated" else 0
    used = {m.get("source", "") for m in lib.list()}
    csv.field_size_limit(10_000_000)
    where = _cv_file_index(d, repo) if repo else None   # partial re-uploads: only consider clips that exist
    spk: dict[str, dict] = {}
    with open(tsv, encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter="\t", quoting=csv.QUOTE_NONE):
            g = (r.get("gender") or "").lower()
            g = "male" if g.startswith("male") else "female" if g.startswith("female") else ""
            if not g:
                continue
            try:
                up, down = int(r.get("up_votes") or 0), int(r.get("down_votes") or 0)
            except ValueError:
                continue
            if down > 0 or up < min_up:
                continue
            if any(f"speaker {r['client_id'][:12]}" in u for u in used):
                continue   # already in the library from an earlier harvest
            if where is not None and r["path"] not in where and not (d / "clips" / r["path"]).exists():
                continue
            s = spk.setdefault(r["client_id"], {"gender": g, "age": r.get("age") or "", "accent": r.get("accents") or "", "clips": []})
            s["clips"].append((up, r["path"], r.get("sentence") or ""))
    pools = {"male": [], "female": []}
    for cid, s in spk.items():
        if len(s["clips"]) >= 3:
            pools[s["gender"]].append((cid, s))
    for g in pools:   # speakers with many validated clips first (committed contributors, usually a steady setup)
        pools[g].sort(key=lambda x: -len(x[1]["clips"]))
        pools[g] = pools[g][:candidates_per_gender]
    log(f"candidate speakers: {len(pools['male'])} male, {len(pools['female'])} female")
    want = []
    for g, lst in pools.items():
        for cid, s in lst:
            s["clips"].sort(key=lambda c: -c[0])
            for up, path, text in s["clips"][:clips_per_speaker]:
                want.append((cid, path, text))
    clip_dir = d / "clips"
    clip_dir.mkdir(parents=True, exist_ok=True)
    where = where or {}

    def fetch(item):
        cid, path, text = item
        dst = clip_dir / path
        if not dst.exists() and repo and path in where:
            from huggingface_hub import hf_hub_download
            try:
                shutil.copyfile(hf_hub_download(repo, where[path], repo_type="dataset", local_dir=str(d / "_hf")), dst)
            except Exception:
                return None
        return item if dst.exists() else None

    with ThreadPoolExecutor(8) as ex:
        got = [x for x in ex.map(fetch, want) if x]
    log(f"fetched {len(got)}/{len(want)} clips")
    by: dict[str, list] = {}
    for cid, path, text in got:
        try:
            data, sr = sf.read(str(clip_dir / path), dtype="float32")
        except Exception:
            continue
        if data.ndim > 1:
            data = data.mean(axis=1)
        a = A.trim_silence(data.astype(np.float32), sr)
        q = quality(a, sr)
        if q["clip"] > 1e-4 or q["snr"] < min_snr or q["dur"] < 2.0:
            continue
        by.setdefault(cid, []).append({"audio": a, "sr": sr, "text": text, **q})
    cands = []
    for cid, cs in by.items():
        cs.sort(key=lambda c: -c["snr"])
        parts, dur = [], 0.0
        for c in cs:
            if c["sr"] != cs[0]["sr"] or dur + c["dur"] > max_s:
                continue
            parts.append(c)
            dur += c["dur"] + 0.35
            if dur >= min_s + 1:
                break
        if dur < min_s:
            continue
        gap = np.zeros(int(parts[0]["sr"] * 0.35), np.float32)
        joined = np.concatenate([x for p in parts for x in (p["audio"], gap)][:-1])
        s = spk[cid]
        cands.append({"cid": cid, "audio": joined, "sr": parts[0]["sr"], "text": " ".join(p["text"] for p in parts), "snr": min(p["snr"] for p in parts),
                      "dur": round(len(joined) / parts[0]["sr"], 2), "gender": s["gender"], "age": s["age"], "accent": s["accent"], "n": len(parts)})
    log(f"{len(cands)} speakers have a clean {min_s:.0f}+ s reference")
    from resemblyzer import VoiceEncoder, preprocess_wav
    enc = VoiceEncoder("cpu", verbose=False)
    cap = per_gender or (max_voices + 1) // 2
    counts = {"male": 0, "female": 0}
    chosen, embs = [], []
    for c in sorted(cands, key=lambda c: -c["snr"]):
        if len(chosen) >= max_voices or counts[c["gender"]] >= cap:
            continue
        e = enc.embed_utterance(preprocess_wav(c["audio"], source_sr=c["sr"]))
        if any(float(np.dot(e, x)) >= same_speaker for x in embs):
            continue
        embs.append(e)
        counts[c["gender"]] += 1
        chosen.append(c)
    out = []
    tmp = Path(lib.root) / "_harvest.wav"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    existing = {v["voice_id"] for v in lib.list()}
    for c in chosen:
        g = c["gender"][0]
        k = 1
        while f"{prefix or language}-{g}-cv{k:02d}" in existing:
            k += 1
        name = f"{prefix or language}-{g}-cv{k:02d}"
        existing.add(name)
        sf.write(str(tmp), c["audio"] / (float(np.abs(c["audio"]).max()) or 1.0) * 0.9, c["sr"], subtype="PCM_16")
        desc = f"{c['gender']} native {lang_name} speaker" + (f", {c['age']}" if c["age"] else "") + (f", {c['accent']}" if c["accent"] else "")
        meta = lib.add(name, tmp, consent=True, description=desc, gender=c["gender"], tags=["commonvoice", f"lang:{language}"],
                       source=f"Mozilla Common Voice ({lang_name}); speaker {c['cid'][:12]}; {c['n']} clips stitched", license="CC0-1.0",
                       transcript=c["text"] or None, transcribe=False,
                       extra={"language": language, "accent": c["accent"] or f"native {lang_name}", "age": c["age"], "snr": c["snr"]})
        log(f"  + {name:14} {c['gender']:7} {c['age']:10} snr={c['snr']} {c['dur']}s  {c['text'][:40]}")
        out.append(meta)
    tmp.unlink(missing_ok=True)
    return out


def _cv_file_index(d: Path, repo: str) -> dict[str, str]:
    """clip file name -> path inside the repo (re-uploads shard clips into numbered folders). Cached in files.txt."""
    cache = d / "files.txt"
    if not cache.exists():
        from huggingface_hub import list_repo_files
        cache.write_text(chr(10).join(list_repo_files(repo, repo_type="dataset")), encoding="utf-8")
    return {Path(p).name: p for p in cache.read_text(encoding="utf-8").splitlines() if p.endswith(".mp3")}
