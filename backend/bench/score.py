"""Score every engine's output in bench/out/*/ and write bench/report.{json,md,html}.

Metrics per clip:
  wer      word error rate of faster-whisper large-v3-turbo (GPU) vs the requested text, after spoken-form
           canonicalisation (numbers, hyphens, case, punctuation)          -> intelligibility / word skips
  sim      cosine similarity of resemblyzer speaker embeddings vs the reference clip  -> cloning fidelity
  mos      DNSMOS P.835 overall quality (1..5, ONNX, Microsoft)              -> perceived quality proxy
  rtf      wall seconds / audio seconds (lower is faster)
  vram     peak GB during that clip

Run with the main venv:  .venv/Scripts/python.exe -X utf8 bench/score.py
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from firevoice.asr import canon  # noqa: E402  spoken-equivalence canonicaliser


def _resample(a: np.ndarray, sr: int, to: int) -> np.ndarray:
    if sr == to:
        return a
    import librosa
    return librosa.resample(a, orig_sr=sr, target_sr=to)


def wer(ref: str, hyp: str) -> float:
    import jiwer
    r, h = " ".join(canon(ref)), " ".join(canon(hyp))
    if not r:
        return 0.0
    return float(jiwer.wer(r, h or "x"))


def main():
    import torch
    os.add_dll_directory(os.path.join(os.path.dirname(torch.__file__), "lib"))
    from faster_whisper import WhisperModel
    from resemblyzer import VoiceEncoder, preprocess_wav
    from speechmos import dnsmos

    out_dir = ROOT / "bench" / "out"
    engines = sorted(p for p in out_dir.iterdir() if (p / "meta.json").exists())
    if not engines:
        print("nothing to score in", out_dir)
        return 1
    print("loading scorers...", flush=True)
    whisper = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")
    enc = VoiceEncoder("cpu")
    ref_cache: dict[str, np.ndarray] = {}

    def ref_embed(path: str) -> np.ndarray:
        if path not in ref_cache:
            ref_cache[path] = enc.embed_utterance(preprocess_wav(Path(path)))
        return ref_cache[path]

    def predict_mos(a16: np.ndarray) -> float:
        """DNSMOS P.835 overall quality (1..5), Microsoft's ONNX predictor; a naturalness/cleanliness proxy."""
        try:
            r = dnsmos.run(a16, sr=16000, verbose=False)
            return float(r["ovrl_mos"])
        except Exception as e:  # noqa: BLE001
            print("  mos failed:", e)
            return float("nan")

    report = {"engines": []}
    for ed in engines:
        meta = json.loads((ed / "meta.json").read_text(encoding="utf-8"))
        rows = []
        print(f"== {meta['engine']} ({meta.get('mode')})", flush=True)
        for it in meta["items"]:
            wav = ed / f"{it['id']}.wav"
            row = dict(it)
            if not wav.exists() or it.get("error"):
                row.update(wer=1.0, sim=0.0, mos=float("nan"), said="")
                rows.append(row)
                continue
            a, sr = sf.read(str(wav), dtype="float32")
            if a.ndim > 1:
                a = a.mean(axis=1)
            a16 = _resample(a, sr, 16000)
            segs, _ = whisper.transcribe(a16, language="en", beam_size=3, vad_filter=False)
            said = " ".join(s.text.strip() for s in segs)
            row["said"] = said
            row["wer"] = round(wer(it["text"], said), 3)
            try:
                e = enc.embed_utterance(preprocess_wav(a16, source_sr=16000))
                row["sim"] = round(float(np.dot(e, ref_embed(meta["ref"]))), 3)
            except Exception:
                row["sim"] = float("nan")
            row["mos"] = round(predict_mos(a16), 3)
            rows.append(row)
            print(f"  {it['id']:10} wer={row['wer']:.2f} sim={row['sim']:.2f} mos={row['mos']:.2f} rtf={it.get('rtf')}", flush=True)

        def mean(k):
            v = [r[k] for r in rows if isinstance(r.get(k), (int, float)) and r[k] == r[k] and r.get(k) is not None]
            return round(float(np.mean(v)), 3) if v else None

        summary = {"engine": meta["engine"], "mode": meta.get("mode"), "notes": meta.get("notes"), "load_seconds": meta.get("load_seconds"),
                   "load_vram_gb": meta.get("load_vram_gb"), "wer": mean("wer"), "sim": mean("sim"), "mos": mean("mos"), "rtf": mean("rtf"),
                   "peak_vram_gb": max((r.get("peak_vram_gb") or 0) for r in rows) if rows else None,
                   "errors": sum(1 for r in rows if r.get("error")), "items": rows}
        report["engines"].append(summary)

    # rank: naturalness first, then intelligibility, then similarity (cloning engines only)
    ranked = sorted(report["engines"], key=lambda s: (-(s["mos"] or 0), (s["wer"] or 1), -(s["sim"] or 0)))
    report["ranking"] = [s["engine"] for s in ranked]
    (ROOT / "bench" / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")

    lines = ["# FireVoice engine bake-off", "", f"Reference: `{Path(ranked[0]['items'][0].get('ref', '')).name if ranked and ranked[0]['items'] else ''}`  ·  texts: `bench/texts.json`  ·  scorer: whisper large-v3-turbo WER, resemblyzer similarity, DNSMOS P.835 overall MOS", "",
             "| engine | mode | MOS (1-5) | WER | spk sim | RTF | load s | peak VRAM GB | errors | notes |", "|---|---|---|---|---|---|---|---|---|---|"]
    for s in ranked:
        lines.append(f"| {s['engine']} | {s['mode']} | {s['mos']} | {s['wer']} | {s['sim']} | {s['rtf']} | {s['load_seconds']} | {s['peak_vram_gb']} | {s['errors']} | {s['notes'] or ''} |")
    lines += ["", "## Per clip", ""]
    for s in ranked:
        lines += [f"### {s['engine']}", "", "| id | MOS | WER | sim | RTF | heard |", "|---|---|---|---|---|---|"]
        for r in s["items"]:
            lines.append(f"| {r['id']} | {r.get('mos')} | {r.get('wer')} | {r.get('sim')} | {r.get('rtf')} | {str(r.get('said', ''))[:110].replace('|', '/')} |")
        lines.append("")
    (ROOT / "bench" / "report.md").write_text("\n".join(lines), encoding="utf-8")

    # listening page: one row per text, one column per engine
    ids = [i["id"] for i in json.loads((ROOT / "bench" / "texts.json").read_text(encoding="utf-8"))["items"]]
    h = ["<!doctype html><meta charset=utf-8><title>FireVoice bake-off</title>",
         "<style>body{font:14px system-ui;margin:20px;background:#111;color:#eee}table{border-collapse:collapse}td,th{border:1px solid #333;padding:6px;vertical-align:top}th{background:#222;position:sticky;top:0}audio{width:230px}small{color:#9a9}.m{color:#fc6}</style>",
         "<h1>FireVoice engine bake-off</h1><p>Rows: test texts. Columns: engines (ranked by predicted MOS). Numbers: MOS / WER / speaker similarity / RTF.</p><table><tr><th>text</th>"]
    h += [f"<th>{s['engine']}<br><small>{s['mode']}</small><br><span class=m>MOS {s['mos']} · WER {s['wer']} · sim {s['sim']} · RTF {s['rtf']}</span></th>" for s in ranked]
    h.append("</tr>")
    for tid in ids:
        h.append(f"<tr><td><b>{tid}</b></td>")
        for s in ranked:
            r = next((x for x in s["items"] if x["id"] == tid), None)
            if r and not r.get("error") and (out_dir / s["engine"] / f"{tid}.wav").exists():
                rel = f"out/{s['engine']}/{tid}.wav"
                h.append(f"<td><audio controls preload=none src='{rel}'></audio><br><small>MOS {r.get('mos')} · WER {r.get('wer')} · sim {r.get('sim')} · RTF {r.get('rtf')}</small></td>")
            else:
                h.append(f"<td><small>error: {(r or {}).get('error', 'missing')}</small></td>")
        h.append("</tr>")
    h.append("</table>")
    (ROOT / "bench" / "report.html").write_text("\n".join(h), encoding="utf-8")
    print("\n".join(lines[:4 + len(ranked) + 2]))
    print(f"\nwrote bench/report.md, bench/report.json, bench/report.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
