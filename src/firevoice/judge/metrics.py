"""Stage `metrics` (main venv): intelligibility (Whisper large-v3-turbo), similarity to the original voice
(resemblyzer), and prosody liveliness. Writes judge/metrics.jsonl, one line per clip, resumable."""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

import numpy as np
import soundfile as sf

from ..asr import canon


def _load16(path: str) -> np.ndarray:
    a, sr = sf.read(path, dtype="float32", always_2d=False)
    if a.ndim > 1:
        a = a.mean(axis=1)
    if sr != 16000:
        import librosa
        a = librosa.resample(a, orig_sr=sr, target_sr=16000)
    return a.astype(np.float32)


def _edit(a: list, b: list) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def _chars(s: str) -> list[str]:
    s = unicodedata.normalize("NFKC", s).lower()
    return [c for c in s if unicodedata.category(c)[0] in "LN"]   # letters and digits only, any script


def error_rate(ref: str, hyp: str, lang: str) -> tuple[float, str]:
    """English: word error rate on the spoken-equivalence canon. Other languages: character error rate."""
    if lang.startswith("en"):
        r, h = canon(ref), canon(hyp)
        return (min(1.0, _edit(r, h) / max(1, len(r))), "wer")
    r, h = _chars(ref), _chars(hyp)
    return (min(1.0, _edit(r, h) / max(1, len(r))), "cer")


def prosody(a: np.ndarray, words: int, sr: int = 16000) -> dict:
    """Pitch movement (semitone spread over voiced frames), speaking rate over voiced+active time, pause share and
    loudness movement. Flat, metronomic TTS scores low on the first and last."""
    import librosa
    hop = 160
    rms = librosa.feature.rms(y=a, frame_length=640, hop_length=hop)[0]
    active = rms > max(1e-4, 0.08 * float(np.percentile(rms, 95)))
    f0 = librosa.yin(a, fmin=60, fmax=500, sr=sr, frame_length=1024, hop_length=hop)
    n = min(len(f0), len(active))
    f0, act = f0[:n], active[:n]
    voiced = f0[act & (f0 > 60) & (f0 < 500)]
    if len(voiced) > 20:
        st = 12 * np.log2(voiced / np.median(voiced))
        pitch_st = float(np.percentile(st, 90) - np.percentile(st, 10))
    else:
        pitch_st = 0.0
    # internal pauses: silent runs between the first and last active frame
    idx = np.flatnonzero(act)
    inner = act[idx[0]: idx[-1] + 1] if len(idx) else act
    pause_share = float(1 - inner.mean()) if len(inner) else 0.0
    active_s = float(inner.sum()) * hop / sr
    db = 20 * np.log10(rms[active] + 1e-6) if active.any() else np.zeros(1)
    return {"pitch_range_st": round(pitch_st, 2), "f0_median": round(float(np.median(voiced)) if len(voiced) else 0.0, 1),
            "rate_wps": round(words / max(0.5, active_s), 2), "pause_share": round(pause_share, 3),
            "loud_range_db": round(float(np.percentile(db, 90) - np.percentile(db, 10)), 2)}


def run(samples_dir: str | Path, log=print) -> int:
    from resemblyzer import VoiceEncoder, preprocess_wav

    from ..asr import FasterWhisperAligner

    jd = Path(samples_dir) / "judge"
    clips = json.loads((jd / "clips.json").read_text(encoding="utf-8"))["clips"]
    out = jd / "metrics.jsonl"
    done = set()
    if out.exists():
        done = {json.loads(l)["key"] for l in out.read_text(encoding="utf-8").splitlines() if l.strip()}
    todo = [c for c in clips if c["key"] not in done]
    log(f"metrics: {len(todo)} of {len(clips)} clips to score")
    if not todo:
        return 0
    enc = VoiceEncoder("cuda" if _cuda() else "cpu", verbose=False)
    asr: dict[str, FasterWhisperAligner] = {}
    ref_emb: dict[str, np.ndarray] = {}
    with open(out, "a", encoding="utf-8") as fh:
        for i, c in enumerate(todo, 1):
            a = _load16(c["file"])
            lang = c["asr_lang"]
            if lang not in asr:
                asr[lang] = FasterWhisperAligner("auto", language=lang, concurrency=1)
            said, _ = asr[lang].transcribe_text(a, 16000, beam_size=3)
            err, kind = error_rate(c["asr_ref"], said, lang)
            if err > 0.2:   # Whisper's VAD sometimes stops after the first sentence: retry without it before blaming the clip
                said2 = " ".join(w.text for w in asr[lang].transcribe(a, 16000))
                err2, _ = error_rate(c["asr_ref"], said2, lang)
                if err2 < err:
                    said, err = said2, err2
            rec = {"key": c["key"], "heard": said, "err": round(err, 4), "err_kind": kind}
            e = enc.embed_utterance(preprocess_wav(a, source_sr=16000))
            if c.get("ref"):
                if c["ref"] not in ref_emb:
                    ref_emb[c["ref"]] = enc.embed_utterance(preprocess_wav(_load16(c["ref"]), source_sr=16000))
                rec["sim"] = round(float(np.dot(e, ref_emb[c["ref"]])), 4)
            nw = len(canon(c["text"])) if c["lang"].startswith("en") else len(re.findall(r"\w+", c["asr_ref"]))
            rec.update(prosody(a, nw))
            rec["emb"] = [round(float(x), 5) for x in e]   # kept for voice-consistency checks across a voice's clips
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fh.flush()
            if i % 25 == 0:
                log(f"  {i}/{len(todo)}  last: {c['key']}  {kind}={err:.3f}  sim={rec.get('sim', '-')}")
    return 0


def _cuda() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False
