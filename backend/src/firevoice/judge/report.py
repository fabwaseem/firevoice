"""Stage `report` (main venv): merge metrics, listening models and SpeechJudge tournaments into ranked lists.

Scores are percentiles inside the group being compared (same text), so a voice is only ever measured against
clips that said the same words. Weights:
  realism (gallery, designs, long-form)  judge 50 · UTMOSv2 30 · intelligibility 10 · prosody liveliness 10
  style performance (per style)          judge 45 · style fit 25 · UTMOSv2 15 · intelligibility 15
  without judge results (other languages) UTMOSv2 60 · intelligibility 40
"""
from __future__ import annotations

import html
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import mean

# what each delivery should do relative to the same voice's average delivery: +1 more, -1 less
STYLE_TARGETS = {
    "excited": {"arousal": 1, "valence": 1, "happy": 1, "rate": 1}, "sports": {"arousal": 1, "rate": 1, "loud": 1},
    "angry": {"arousal": 1, "valence": -1, "dominance": 1, "angry": 1}, "sad": {"arousal": -1, "valence": -1, "sad": 1, "rate": -1},
    "calm": {"arousal": -1, "rate": -1}, "bedtime": {"arousal": -1, "rate": -1}, "asmr": {"arousal": -1, "loud": -1},
    "horror": {"arousal": -1, "valence": -1, "fearful": 1}, "dramatic": {"pitch": 1, "dominance": 1}, "trailer": {"dominance": 1, "rate": -1},
    "deadpan": {"pitch": -1, "arousal": -1, "neutral": 1}, "serious": {"valence": -1, "dominance": 1}, "newscaster": {"dominance": 1},
    "curious": {"pitch": 1, "surprised": 1}, "reflective": {"arousal": -1, "rate": -1}, "documentary": {"dominance": 1, "rate": -1},
    "storyteller": {"pitch": 1},
}
EMOTION_TARGETS = {
    "happy": {"valence": 1, "arousal": 1, "happy": 1}, "sad": {"valence": -1, "arousal": -1, "sad": 1}, "angry": {"arousal": 1, "valence": -1, "angry": 1, "dominance": 1},
    "whisper": {"arousal": -1, "loud": -1}, "shocked": {"arousal": 1, "surprised": 1, "pitch": 1}, "sarcastic": {"valence": -1, "pitch": -1},
    "very fast": {"rate": 1}, "very slow": {"rate": -1},
}
SCALE = {"arousal": 0.08, "valence": 0.08, "dominance": 0.08, "rate": 0.4, "pitch": 1.5, "loud": 2.0}


def _feat(r: dict, k: str):
    if k in ("arousal", "valence", "dominance"):
        return r.get(k)
    if k == "rate":
        return r.get("rate_wps")
    if k == "pitch":
        return r.get("pitch_range_st")
    if k == "loud":
        return r.get("loud_range_db")
    return (r.get("emotion") or {}).get(k)


def fit(r: dict, base: dict, target: dict) -> float | None:
    """0..1: how far the delivery moved in the intended directions relative to the baseline."""
    vals = []
    for k, sign in target.items():
        a, b = _feat(r, k), _feat(base, k)
        if a is None or b is None:
            continue
        sc = SCALE.get(k, 0.15)
        vals.append(0.5 + 0.5 * math.tanh(sign * (a - b) / sc))
    return round(mean(vals), 3) if vals else None


def pct(values: dict[str, float], higher_better: bool = True) -> dict[str, float]:
    items = [(k, v) for k, v in values.items() if v is not None]
    if not items:
        return {}
    items.sort(key=lambda kv: kv[1])
    n = len(items)
    out = {}
    for i, (k, v) in enumerate(items):
        p = 100.0 * (i / (n - 1) if n > 1 else 0.5)
        out[k] = round(p if higher_better else 100 - p, 1)
    return out


def combine(parts: list[tuple[float | None, float]]) -> float | None:
    got = [(v, w) for v, w in parts if v is not None]
    if not got:
        return None
    return round(sum(v * w for v, w in got) / sum(w for _, w in got), 1)


def load(jd: Path) -> tuple[dict, dict, dict, dict]:
    clips = {c["key"]: c for c in json.loads((jd / "clips.json").read_text(encoding="utf-8"))["clips"]}
    for name in ("metrics.jsonl", "listen.jsonl", "utmos.jsonl", "judge_scores.jsonl"):
        f = jd / name
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    r = json.loads(line)
                    if r["key"] in clips:
                        r.pop("emb", None)
                        clips[r["key"]].update(r)
    standings = json.loads((jd / "standings.json").read_text(encoding="utf-8")) if (jd / "standings.json").exists() else {}
    judgements = defaultdict(list)
    if (jd / "grm.jsonl").exists():
        for line in (jd / "grm.jsonl").read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                judgements[r["a"]].append(r)
                judgements[r["b"]].append(r)
    return clips, standings, judgements, {}


def rank_group(rows: list[dict], standing: list[dict] | None, weights: dict, fits: dict | None = None) -> list[dict]:
    rating = {s["key"]: s for s in (standing or [])}
    if any(r.get("judge") is not None for r in rows):
        jp = pct({r["key"]: r.get("judge") for r in rows})
    else:
        jp = pct({r["key"]: rating.get(r["key"], {}).get("rating") for r in rows})
    up = pct({r["key"]: r.get("utmos") for r in rows})
    ip = {r["key"]: (100 * (1 - r["err"]) if r.get("err") is not None else None) for r in rows}
    lp = pct({r["key"]: r.get("pitch_range_st") for r in rows})
    out = []
    for r in rows:
        k = r["key"]
        parts = [(jp.get(k), weights.get("judge", 0)), (up.get(k), weights.get("utmos", 0)), (ip.get(k), weights.get("intel", 0)),
                 (lp.get(k), weights.get("live", 0))]
        if fits is not None:
            parts.append((None if fits.get(k) is None else 100 * fits[k], weights.get("fit", 0)))
        s = rating.get(k, {})
        out.append({**r, "score": combine(parts), "elo": s.get("rating"), "judge_score": r.get("judge") if r.get("judge") is not None else s.get("judge_score"), "games": s.get("games"),
                    "fit": (fits or {}).get(k)})
    out.sort(key=lambda r: -(r["score"] if r["score"] is not None else -1))
    for i, r in enumerate(out, 1):
        r["rank"] = i
    return out


REALISM = {"judge": 50, "utmos": 30, "intel": 10, "live": 10}
STYLE_W = {"judge": 45, "fit": 25, "utmos": 15, "intel": 15}
NOJUDGE = {"utmos": 60, "intel": 40}


def build(samples_dir: str | Path) -> dict:
    jd = Path(samples_dir) / "judge"
    clips, standings, judgements, _ = load(jd)
    by_sec = defaultdict(list)
    for c in clips.values():
        by_sec[c["section"]].append(c)
    rep: dict = {"engine": None, "sections": {}}

    # realism lists
    for sec in ("gallery", "design", "longform"):
        if by_sec.get(sec):
            rep["sections"][sec] = rank_group(by_sec[sec], standings.get(sec), REALISM)

    # styles: per style ranking with style fit relative to the voice's own average delivery
    st_rows = by_sec.get("styles", [])
    voice_avg = defaultdict(dict)
    for v in {r["voice"] for r in st_rows}:
        mine = [r for r in st_rows if r["voice"] == v]
        for k in ("arousal", "valence", "dominance", "rate", "pitch", "loud", "happy", "sad", "angry", "fearful", "surprised", "neutral"):
            xs = [_feat(r, k) for r in mine if _feat(r, k) is not None]
            if xs:
                voice_avg[v][k] = mean(xs)

    def avg_row(v):
        a = voice_avg[v]
        return {"arousal": a.get("arousal"), "valence": a.get("valence"), "dominance": a.get("dominance"), "rate_wps": a.get("rate"),
                "pitch_range_st": a.get("pitch"), "loud_range_db": a.get("loud"),
                "emotion": {k: a[k] for k in ("happy", "sad", "angry", "fearful", "surprised", "neutral") if k in a}}

    styles = {}
    for st in sorted({r["style"] for r in st_rows}):
        rows = [r for r in st_rows if r["style"] == st]
        fits = {r["key"]: fit(r, avg_row(r["voice"]), STYLE_TARGETS[st]) if st in STYLE_TARGETS else None for r in rows}
        styles[st] = rank_group(rows, standings.get(f"style:{st}"), STYLE_W, fits)
    rep["styles"] = styles
    rep["style_summary"] = sorted(({
        "style": st, "fit": _m([r["fit"] for r in rows]), "utmos": _m([r.get("utmos") for r in rows]), "judge": _m([r.get("judge") for r in rows]),
        "intel": _m([1 - r["err"] for r in rows if r.get("err") is not None]), "winner": rows[0]["voice_label"] if rows else None,
        "measurable": st in STYLE_TARGETS} for st, rows in styles.items()), key=lambda x: -((x["judge"] or 0) * 10 + (x["utmos"] or 0) * 10 + (x["fit"] or 0.5) * 30))

    # emotion instructions: same voice, same line, only the instruction changes
    em = by_sec.get("emotion", [])
    base = {r["voice"]: r for r in em if r["variant"] == "no instruction"}
    em_rows = []
    for r in em:
        if r["variant"] in EMOTION_TARGETS and r["voice"] in base:
            r["fit"] = fit(r, base[r["voice"]], EMOTION_TARGETS[r["variant"]])
            em_rows.append(r)
    rep["emotion_by_instruction"] = sorted(({"instruction": var, "fit": _m([r["fit"] for r in em_rows if r["variant"] == var]),
                                            "utmos": _m([r.get("utmos") for r in em_rows if r["variant"] == var]),
                                            "best_voice": max((r for r in em_rows if r["variant"] == var), key=lambda r: (r["fit"] or 0) + (r.get("utmos") or 0) / 10)["voice_label"]}
                                           for var in EMOTION_TARGETS if any(r["variant"] == var for r in em_rows)), key=lambda x: -(x["fit"] or 0))
    rep["emotion_by_voice"] = sorted(({"voice": v, "expressiveness": _m([r["fit"] for r in em_rows if r["voice"] == v]),
                                      "utmos": _m([r.get("utmos") for r in em if r["voice"] == v])} for v in base), key=lambda x: -(x["expressiveness"] or 0))
    rep["emotion_rows"] = em_rows

    # plain vs ultimate clone
    cm = by_sec.get("clone_modes", [])
    pairs = []
    for v in sorted({r["voice"] for r in cm}):
        a = next((r for r in cm if r["voice"] == v and r["variant"] == "plain clone"), None)
        b = next((r for r in cm if r["voice"] == v and r["variant"] == "ultimate clone"), None)
        if not a or not b:
            continue
        ja, jb = a.get("judge"), b.get("judge")
        pairs.append({"voice": v, "plain": a, "ultimate": b, "judge_plain": ja, "judge_ultimate": jb,
                      "winner": None if ja is None or jb is None else ("ultimate" if jb - ja > 0.05 else "plain" if ja - jb > 0.05 else "tie"),
                      "sim_delta": None if a.get("sim") is None or b.get("sim") is None else round(b["sim"] - a["sim"], 4),
                      "utmos_delta": None if a.get("utmos") is None or b.get("utmos") is None else round(b["utmos"] - a["utmos"], 3)})
    rep["clone_modes"] = pairs

    # Urdu: per script and per voice (judge not used: it was trained on English and Chinese)
    ur = by_sec.get("urdu", []) + by_sec.get("urdu_more", [])
    rep["urdu_scripts"] = [{"script": tk, "cer": _m([r.get("err") for r in ur if r["text_key"] == tk]), "utmos": _m([r.get("utmos") for r in ur if r["text_key"] == tk]),
                            "clips": sum(1 for r in ur if r["text_key"] == tk)} for tk in ("ur_script", "ur_deva", "ur_roman") if any(r["text_key"] == tk for r in ur)]
    best_script = min(rep["urdu_scripts"], key=lambda x: (x["cer"] or 9) - (x["utmos"] or 0) / 10)["script"] if rep["urdu_scripts"] else None
    rep["urdu_best_script"] = best_script
    if best_script:
        rep["urdu_voices"] = rank_group([r for r in ur if r["text_key"] == best_script], None, NOJUDGE)
    rep["urdu_english"] = rank_group([r for r in by_sec.get("urdu", []) if r["text_key"] == "intro"], None, NOJUDGE)

    # languages
    ml = by_sec.get("multilingual", [])
    rep["languages"] = sorted(({"lang": tk, "cer": _m([r.get("err") for r in ml if r["text_key"] == tk]), "utmos": _m([r.get("utmos") for r in ml if r["text_key"] == tk]),
                               "sim": _m([r.get("sim") for r in ml if r["text_key"] == tk])} for tk in sorted({r["text_key"] for r in ml})), key=lambda x: (x["cer"] or 9))
    rep["language_voices"] = sorted(({"voice": v, "cer": _m([r.get("err") for r in ml if r["voice"] == v]), "utmos": _m([r.get("utmos") for r in ml if r["voice"] == v]),
                                     "sim": _m([r.get("sim") for r in ml if r["voice"] == v])} for v in {r["voice"] for r in ml}), key=lambda x: -((x["utmos"] or 0) - 3 * (x["cer"] or 0)))

    # knobs: averaged over the voices
    kn = by_sec.get("knobs", [])
    ks = []
    for var in sorted({r["variant"] for r in kn}):
        rows = [r for r in kn if r["variant"] == var]
        el = []
        for r in rows:
            s = {x["key"]: x for x in standings.get(f"knobs:{r['voice']}", [])}
            if r["key"] in s:
                el.append(s[r["key"]]["rating"])
        ks.append({"setting": var, "elo": _m(el), "judge": _m([r.get("judge") for r in rows]), "utmos": _m([r.get("utmos") for r in rows]), "wer": _m([r.get("err") for r in rows]),
                   "rtf": _m([r.get("rtf") for r in rows]), "overrides": rows[0].get("overrides", {})})
    ks.sort(key=lambda x: -((x["judge"] or 0) + (x["utmos"] or 0) + ((x["elo"] or 1500) - 1500) / 100))
    rep["knobs"] = ks

    # reliability: a voice's score in the gallery vs its scores elsewhere (different texts, same voice)
    def spearman(xs, ys):
        n = len(xs)
        if n < 4:
            return None
        rx = {k: i for i, k in enumerate(sorted(range(n), key=lambda i: xs[i]))}
        ry = {k: i for i, k in enumerate(sorted(range(n), key=lambda i: ys[i]))}
        d = sum((rx[i] - ry[i]) ** 2 for i in range(n))
        return round(1 - 6 * d / (n * (n * n - 1)), 3)

    gal = {r["voice"]: r for r in by_sec.get("gallery", [])}
    rel = []
    for metric in ("judge", "utmos"):
        for sec in ("styles", "clone_modes", "emotion"):
            per = defaultdict(list)
            for r in by_sec.get(sec, []):
                if r.get(metric) is not None and (sec != "clone_modes" or r["variant"] == "plain clone") and (sec != "emotion" or r["variant"] == "no instruction"):
                    per[r["voice"]].append(r[metric])
            common = [v for v in per if v in gal and gal[v].get(metric) is not None]
            if len(common) >= 4:
                rel.append({"metric": metric, "against": sec, "voices": len(common),
                            "spearman": spearman([gal[v][metric] for v in common], [mean(per[v]) for v in common])})
    rep["reliability"] = rel

    # headline picks
    g = rep["sections"].get("gallery", [])
    picks = {"overall": [r["voice_label"] for r in g[:10]],
             "male": [r["voice_label"] for r in g if r.get("gender") == "male"][:5],
             "female": [r["voice_label"] for r in g if r.get("gender") == "female"][:5],
             "designed": [r["voice_label"] for r in rep["sections"].get("design", [])[:5]],
             "per_style": {st: rows[0]["voice_label"] for st, rows in styles.items() if rows},
             "urdu": [r["voice_label"] for r in rep.get("urdu_voices", [])[:5]]}
    by_accent = defaultdict(list)
    for r in g:
        by_accent[(r.get("accent") or ("native " + r.get("voice_lang", "")) if r.get("voice_lang") != "en" else r.get("accent") or "audiobook / studio")].append(r)
    picks["per_accent"] = {a: rows[0]["voice_label"] for a, rows in sorted(by_accent.items()) if rows}
    rep["picks"] = picks
    rep["has_judge"] = bool(standings)
    rep["has_utmos"] = any(c.get("utmos") is not None for c in clips.values())
    rep["judgements"] = {k: v[:3] for k, v in judgements.items()}
    (jd / "report.json").write_text(json.dumps(_strip(rep), indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    write_md(jd, rep)
    write_html(jd, rep, judgements)
    return rep


def _m(xs):
    xs = [x for x in xs if x is not None]
    return round(mean(xs), 3) if xs else None


def _strip(rep):
    def clean(r):
        return {k: v for k, v in r.items() if k not in ("emb", "heard")} if isinstance(r, dict) else r
    out = dict(rep)
    out["sections"] = {k: [clean(r) for r in v] for k, v in rep["sections"].items()}
    out["styles"] = {k: [clean(r) for r in v] for k, v in rep["styles"].items()}
    out.pop("judgements", None)
    return out


# ------------------------------------------------------------------------------------------------ output
def _f(x, n=2):
    return "-" if x is None else (f"{x:.{n}f}" if isinstance(x, float) else str(x))


def write_md(jd: Path, rep: dict) -> None:
    L = ["# FireVoice automated listening test", "",
         "Judge: SpeechJudge-GRM (Qwen2.5-Omni trained on 99K human naturalness votes) scores every clip on its own, as a "
         "probability-weighted 1-9 naturalness score; ranks compare only clips that said the same words. Also UTMOSv2 naturalness MOS, "
         "Whisper intelligibility, similarity to the original speaker, emotion2vec+ and arousal/valence/dominance for style fit.", ""]
    has_judge = any(r.get("judge") is not None for r in rep["sections"].get("gallery", []))
    rep["has_judge"] = rep.get("has_judge") or has_judge
    if rep.get("reliability"):
        L += ["**Reliability** (does a metric rank the same voices the same way when they read different texts? Spearman, 1 = identical order):", ""]
        L += [f"- {x['metric']} gallery vs {x['against']}: {_f(x['spearman'])} over {x['voices']} voices" for x in rep["reliability"]]
        L.append("")
    if not rep.get("has_judge") or not rep.get("has_utmos"):
        L += ["> **Preliminary:** " + ", ".join(x for x, ok in (("SpeechJudge tournaments", rep.get("has_judge")), ("UTMOSv2", rep.get("has_utmos"))) if not ok)
              + " not run yet; ranks use what is available (the judge score when present, intelligibility, prosody).", ""]
    g = rep["sections"].get("gallery", [])
    if g:
        L += ["## Most realistic voices", "", "| # | voice | gender | accent / source | score | judge 1-9 | UTMOS | WER | sim to original |", "|---|---|---|---|---|---|---|---|---|"]
        for r in g:
            L.append(f"| {r['rank']} | {r['voice_label']} | {r.get('gender', '')} | {(r.get('accent') or r.get('description', ''))[:40]} | {_f(r['score'], 1)} | {_f(r['judge_score'])} | {_f(r.get('utmos'))} | {_f(r.get('err'), 3)} | {_f(r.get('sim'), 3)} |")
        L.append("")
    if rep.get("style_summary"):
        L += ["## Styles: which deliveries VoxCPM2 does best", "", "| style | judge 1-10 | UTMOS | style fit | intelligibility | best voice |", "|---|---|---|---|---|---|"]
        for s in rep["style_summary"]:
            L.append(f"| {s['style']} | {_f(s['judge'])} | {_f(s['utmos'])} | {_f(s['fit']) if s['measurable'] else 'n/a'} | {_f(s['intel'])} | {s['winner']} |")
        L.append("")
    d = rep["sections"].get("design", [])
    if d:
        L += ["## Designed voices", "", "| # | voice | score | judge 1-10 | UTMOS |", "|---|---|---|---|---|"]
        L += [f"| {r['rank']} | {r['voice_label']} | {_f(r['score'], 1)} | {_f(r['judge_score'])} | {_f(r.get('utmos'))} |" for r in d]
        L.append("")
    if rep.get("emotion_by_instruction"):
        L += ["## Emotion instructions (how much each one actually changes the delivery)", "", "| instruction | fit 0-1 | UTMOS | best voice |", "|---|---|---|---|"]
        L += [f"| {e['instruction']} | {_f(e['fit'])} | {_f(e['utmos'])} | {e['best_voice']} |" for e in rep["emotion_by_instruction"]]
        L.append("")
    if rep.get("clone_modes"):
        w = sum(1 for p in rep["clone_modes"] if p["winner"] == "ultimate")
        verdict = f"ultimate won {w} of {len(rep['clone_modes'])}" if any(p["winner"] for p in rep["clone_modes"]) else "judge pending"
        L += [f"## Plain vs ultimate clone: {verdict}", "",
              f"Mean similarity change {_f(_m([p['sim_delta'] for p in rep['clone_modes']]), 4)}, mean UTMOS change {_f(_m([p['utmos_delta'] for p in rep['clone_modes']]), 3)}.", ""]
    if rep.get("urdu_scripts"):
        L += ["## Urdu", "", "| written as | CER | UTMOS | clips |", "|---|---|---|---|"]
        L += [f"| {s['script']} | {_f(s['cer'], 3)} | {_f(s['utmos'])} | {s['clips']} |" for s in rep["urdu_scripts"]]
        L += ["", f"Best way to write Urdu for VoxCPM2: **{rep['urdu_best_script']}**.", "", "| # | Urdu voice | score | CER | UTMOS |", "|---|---|---|---|---|"]
        L += [f"| {r['rank']} | {r['voice_label']} | {_f(r['score'], 1)} | {_f(r.get('err'), 3)} | {_f(r.get('utmos'))} |" for r in rep.get("urdu_voices", [])[:12]]
        L.append("")
    if rep.get("languages"):
        L += ["## Other languages", "", "| language | CER | UTMOS | similarity |", "|---|---|---|---|"]
        L += [f"| {x['lang']} | {_f(x['cer'], 3)} | {_f(x['utmos'])} | {_f(x['sim'], 3)} |" for x in rep["languages"]]
        L.append("")
    if rep.get("knobs"):
        L += ["## Quality settings", "", "| setting | judge 1-9 | UTMOS | WER |", "|---|---|---|---|"]
        L += [f"| {k['setting']} | {_f(k['judge'])} | {_f(k['utmos'])} | {_f(k['wer'], 3)} |" for k in rep["knobs"]]
        L.append("")
    (jd / "report.md").write_text("\n".join(L), encoding="utf-8")


CSS = """:root{--bg:#0d0f13;--p:#151821;--l:#262a35;--f:#e9eaee;--m:#8d93a1;--a:#ff7a45;--g:#4cc38a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--f);font:14px/1.5 system-ui,Segoe UI,sans-serif}
header{padding:22px 26px;border-bottom:1px solid var(--l)}h1{margin:0;font-size:21px}header p{color:var(--m);margin:6px 0 0;max-width:1000px}
nav{display:flex;gap:6px;flex-wrap:wrap;padding:10px 26px;position:sticky;top:0;background:rgba(13,15,19,.96);border-bottom:1px solid var(--l);z-index:3}
nav a{color:var(--f);text-decoration:none;border:1px solid var(--l);border-radius:999px;padding:3px 10px;font-size:12.5px;background:var(--p)}
main{padding:6px 26px 60px}section{margin-top:28px}h2{font-size:17px;margin:0 0 4px}.sub{color:var(--m);margin:0 0 10px;max-width:1000px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}.card{background:var(--p);border:1px solid var(--l);border-radius:10px;padding:12px}
.card b{display:block;font-size:12px;color:var(--m);text-transform:uppercase;letter-spacing:.04em}.card span{font-size:15px;font-weight:600}
.wrap{overflow-x:auto;border:1px solid var(--l);border-radius:10px}table{border-collapse:collapse;width:100%}
th,td{padding:7px 10px;border-bottom:1px solid var(--l);text-align:left;vertical-align:middle;white-space:nowrap}th{background:var(--p);font-size:12px;color:var(--m)}
td.d{white-space:normal;max-width:300px;color:var(--m);font-size:12px}audio{height:30px;width:210px}.bar{display:inline-block;height:8px;border-radius:4px;background:var(--a);vertical-align:middle;margin-right:6px}
.top td:first-child{color:var(--g);font-weight:700}details{margin-top:4px}summary{cursor:pointer;color:var(--m);font-size:12px}pre{white-space:pre-wrap;font-size:12px;color:#c7cbd6;max-width:900px}"""


def write_html(jd: Path, rep: dict, judgements: dict) -> None:
    e = html.escape

    def play(r, key="file"):
        p = Path(r[key]) if r.get(key) else None
        if not p:
            return ""
        try:
            rel = p.relative_to(jd.parent.resolve()).as_posix()
            src = "../" + rel
        except ValueError:
            src = p.as_uri()
        return f"<audio controls preload=none src='{e(src)}'></audio>"

    def orig(r):
        v = r["voice"]
        f = jd.parent / "_refs" / f"{v}.wav"
        return f"<audio controls preload=none src='../_refs/{e(v)}.wav'></audio>" if f.exists() else "<span class=sub>designed</span>"

    def bar(x):
        return "" if x is None else f"<span class=bar style='width:{max(2, int(x))}px'></span>{x:.0f}"

    def why(r):
        js = judgements.get(r["key"], [])
        won = [j for j in js if j.get("scores") and ((j["a"] == r["key"] and j["scores"][0] > j["scores"][1]) or (j["b"] == r["key"] and j["scores"][1] > j["scores"][0]))]
        j = (won or js)[:1]
        if not j:
            return ""
        side = "A" if j[0]["a"] == r["key"] else "B"
        return f"<details><summary>judge's notes (this voice was output {side})</summary><pre>{e(j[0]['rationale'][:1800])}</pre></details>"

    def table(rows, cols, n=200, judge_notes=False):
        h = ["<div class=wrap><table class=top><tr>" + "".join(f"<th>{e(c[0])}</th>" for c in cols) + "</tr>"]
        for r in rows[:n]:
            h.append("<tr>" + "".join(f"<td{' class=d' if c[0] in ('voice', 'description', 'notes') else ''}>{c[1](r)}</td>" for c in cols) + "</tr>")
            if judge_notes:
                w = why(r)
                if w:
                    h.append(f"<tr><td></td><td colspan={len(cols) - 1}>{w}</td></tr>")
        h.append("</table></div>")
        return "".join(h)

    realism_cols = [("#", lambda r: r["rank"]), ("voice", lambda r: f"<b>{e(r['voice_label'])}</b><br>{e((r.get('accent') or r.get('description') or '')[:70])}"),
                    ("gender", lambda r: e(r.get("gender", ""))), ("score", lambda r: bar(r["score"])),
                    ("judge 1-9", lambda r: _f(r["judge_score"])), ("UTMOSv2", lambda r: _f(r.get("utmos"))), ("WER", lambda r: _f(r.get("err"), 3)),
                    ("sim to original", lambda r: _f(r.get("sim"), 3)), ("pitch range st", lambda r: _f(r.get("pitch_range_st"), 1)),
                    ("render", play), ("original", orig)]
    p = rep["picks"]
    h = [f"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>FireVoice listening test</title><style>{CSS}</style>",
         "<header><h1>FireVoice automated listening test</h1><p>Every clip was heard by SpeechJudge-GRM, a Qwen2.5-Omni judge trained on 99,000 human "
         "naturalness votes, which scores each clip on its own (probability-weighted 1-9); voices are only ranked against clips that said the same words. "
         "Also UTMOSv2 (VoiceMOS 2024 naturalness predictor, when run), Whisper large-v3-turbo (intelligibility), resemblyzer (similarity to the original "
         "speaker) and emotion2vec+ / arousal-valence-dominance (does a style or emotion actually change the delivery).</p></header><nav>"]
    secs = [("picks", "Top picks"), ("gallery", "Most realistic voices"), ("styles", "Styles"), ("design", "Designed voices"), ("emotion", "Emotions"),
            ("clone", "Clone modes"), ("urdu", "Urdu"), ("langs", "Languages"), ("knobs", "Settings"), ("longform", "Long-form")]
    h += [f"<a href='#{a}'>{t}</a>" for a, t in secs] + ["</nav><main>"]
    if rep.get("reliability"):
        h.append("<section><div class=card><b>reliability</b><span>Does each metric rank the same voices the same way when they read different texts "
                 "(Spearman, 1 = identical order)? " + e("; ".join(f"{x['metric']} vs {x['against']}: {_f(x['spearman'])} ({x['voices']} voices)" for x in rep["reliability"]))
                 + "</span></div></section>")
    has_judge = any(r.get("judge") is not None for r in rep["sections"].get("gallery", []))
    missing = [x for x, ok in (("SpeechJudge scores", has_judge), ("UTMOSv2", rep.get("has_utmos"))) if not ok]
    if missing:
        h.append(f"<section><div class=card><b>not run yet</b><span>{e(' and '.join(missing))}: ranks below use the available scores "
                 "(judge when present, intelligibility, prosody).</span></div></section>")
    cards = [("most realistic", ", ".join(p["overall"][:3])), ("best male", ", ".join(p["male"][:3])), ("best female", ", ".join(p["female"][:3])),
             ("best designed", ", ".join(p["designed"][:3])), ("best Urdu", ", ".join(p["urdu"][:3])),
             ("Urdu: write it as", rep.get("urdu_best_script") or "-"),
             ("ultimate vs plain clone", (f"ultimate won {sum(1 for x in rep['clone_modes'] if x['winner'] == 'ultimate')} of {len(rep['clone_modes'])}"
                                          if any(x["winner"] for x in rep["clone_modes"]) else "judge pending") if rep.get("clone_modes") else "-"),
             ("best settings", rep["knobs"][0]["setting"] if rep.get("knobs") else "-")]
    h.append("<section id=picks><h2>Top picks</h2><div class=cards>" + "".join(f"<div class=card><b>{e(a)}</b><span>{e(b)}</span></div>" for a, b in cards) + "</div>")
    h.append("<h2 style='margin-top:18px'>Best voice per style</h2><div class=cards>" + "".join(f"<div class=card><b>{e(st)}</b><span>{e(v)}</span></div>" for st, v in p["per_style"].items()) + "</div>")
    h.append("<h2 style='margin-top:18px'>Best voice per accent</h2><div class=cards>" + "".join(f"<div class=card><b>{e(a[:40])}</b><span>{e(v)}</span></div>" for a, v in p["per_accent"].items()) + "</div></section>")
    g = rep["sections"].get("gallery", [])
    if g:
        h.append("<section id=gallery><h2>Most realistic voices</h2><p class=sub>Same sentence for every voice, plain clone, no style instruction. "
                 "Score = judge 50% + UTMOSv2 30% + intelligibility 10% + prosody liveliness 10%, each as a percentile within this list.</p>")
        h.append(table(g, realism_cols, judge_notes=True) + "</section>")
    if rep.get("styles"):
        h.append("<section id=styles><h2>Styles</h2><p class=sub>Which delivery styles VoxCPM2 performs best overall (style fit = how far the delivery moved "
                 "in the intended emotional direction compared with the same voice's average; n/a for styles with no measurable emotional target).</p>")
        h.append(table(rep["style_summary"], [("style", lambda s: f"<b>{e(s['style'])}</b>"), ("judge 1-10", lambda s: _f(s["judge"])), ("UTMOSv2", lambda s: _f(s["utmos"])),
                                              ("style fit", lambda s: _f(s["fit"]) if s["measurable"] else "n/a"), ("intelligibility", lambda s: _f(s["intel"])),
                                              ("winner", lambda s: e(s["winner"] or ""))]))
        for st, rows in rep["styles"].items():
            h.append(f"<details><summary><b>{e(st)}</b>: ranking of {len(rows)} voices</summary>")
            h.append(table(rows, [("#", lambda r: r["rank"]), ("voice", lambda r: f"<b>{e(r['voice_label'])}</b>"), ("score", lambda r: bar(r["score"])),
                                  ("judge 1-10", lambda r: _f(r["judge_score"])), ("style fit", lambda r: _f(r["fit"])), ("UTMOSv2", lambda r: _f(r.get("utmos"))),
                                  ("WER", lambda r: _f(r.get("err"), 3)), ("arousal", lambda r: _f(r.get("arousal"))), ("valence", lambda r: _f(r.get("valence"))),
                                  ("render", play)]) + "</details>")
        h.append("</section>")
    d = rep["sections"].get("design", [])
    if d:
        h.append("<section id=design><h2>Designed voices</h2><p class=sub>Invented from a text description only, then locked as library voices.</p>")
        h.append(table(d, [("#", lambda r: r["rank"]), ("voice", lambda r: f"<b>{e(r['voice_label'])}</b><br>{e(r.get('description', ''))}"), ("score", lambda r: bar(r["score"])),
                           ("judge 1-10", lambda r: _f(r["judge_score"])), ("UTMOSv2", lambda r: _f(r.get("utmos"))), ("WER", lambda r: _f(r.get("err"), 3)), ("render", play)], judge_notes=True) + "</section>")
    if rep.get("emotion_by_instruction"):
        h.append("<section id=emotion><h2>Emotion instructions</h2><p class=sub>Same line, same voice; only the bracketed instruction changes. Fit compares each take with that voice's no-instruction take (0.5 = no change).</p>")
        h.append(table(rep["emotion_by_instruction"], [("instruction", lambda x: f"<b>{e(x['instruction'])}</b>"), ("fit", lambda x: _f(x["fit"])),
                                                       ("UTMOSv2", lambda x: _f(x["utmos"])), ("best voice", lambda x: e(x["best_voice"]))]))
        h.append("<h2 style='margin-top:14px'>Most expressive voices</h2>" + table(rep["emotion_by_voice"], [("voice", lambda x: f"<b>{e(x['voice'])}</b>"),
                                                                                                          ("expressiveness", lambda x: _f(x["expressiveness"])), ("UTMOSv2", lambda x: _f(x["utmos"]))]))
        h.append("<details><summary>every emotion take</summary>" + table(sorted(rep["emotion_rows"], key=lambda r: (r["variant"], -(r["fit"] or 0))),
                 [("instruction", lambda r: e(r["variant"])), ("voice", lambda r: e(r["voice_label"])), ("fit", lambda r: _f(r["fit"])), ("UTMOSv2", lambda r: _f(r.get("utmos"))),
                  ("top emotion", lambda r: e(max((r.get("emotion") or {"-": 0}).items(), key=lambda kv: kv[1])[0])), ("render", play)]) + "</details></section>")
    if rep.get("clone_modes"):
        h.append("<section id=clone><h2>Plain clone vs ultimate clone</h2><p class=sub>Both renders of the same line from each voice, scored by the judge "
                 "(a difference under 0.05 counts as a tie).</p>")
        h.append(table(rep["clone_modes"], [("voice", lambda x: f"<b>{e(x['voice'])}</b>"), ("winner", lambda x: e(x["winner"] or "-")),
                                            ("judge plain", lambda x: _f(x["judge_plain"])), ("judge ultimate", lambda x: _f(x["judge_ultimate"])),
                                            ("similarity change", lambda x: _f(x["sim_delta"], 3)), ("UTMOS change", lambda x: _f(x["utmos_delta"], 3)),
                                            ("plain", lambda x: play(x["plain"])), ("ultimate", lambda x: play(x["ultimate"])), ("original", lambda x: orig(x["plain"]))]) + "</section>")
    if rep.get("urdu_scripts"):
        h.append(f"<section id=urdu><h2>Urdu</h2><p class=sub>CER is measured by transcribing each clip with Whisper in Urdu and comparing with the Urdu-script text "
                 f"(the same words in every version). Best way to write Urdu for VoxCPM2: <b>{e(rep['urdu_best_script'] or '-')}</b>. The judge model is not used here "
                 "(it was trained on English and Chinese); ranking = UTMOSv2 60% + intelligibility 40%.</p>")
        h.append(table(rep["urdu_scripts"], [("written as", lambda s: f"<b>{e(s['script'])}</b>"), ("CER", lambda s: _f(s["cer"], 3)), ("UTMOSv2", lambda s: _f(s["utmos"])), ("clips", lambda s: s["clips"])]))
        h.append("<h2 style='margin-top:14px'>Best Urdu voices</h2>" + table(rep.get("urdu_voices", []), [("#", lambda r: r["rank"]), ("voice", lambda r: f"<b>{e(r['voice_label'])}</b><br>{e(r.get('description', ''))}"),
                 ("score", lambda r: bar(r["score"])), ("CER", lambda r: _f(r.get("err"), 3)), ("UTMOSv2", lambda r: _f(r.get("utmos"))), ("render", play), ("original", orig)]))
        h.append("<h2 style='margin-top:14px'>Urdu speakers reading English</h2>" + table(rep.get("urdu_english", []), [("#", lambda r: r["rank"]), ("voice", lambda r: f"<b>{e(r['voice_label'])}</b>"),
                 ("score", lambda r: bar(r["score"])), ("WER", lambda r: _f(r.get("err"), 3)), ("UTMOSv2", lambda r: _f(r.get("utmos"))), ("render", play)]) + "</section>")
    if rep.get("languages"):
        h.append("<section id=langs><h2>Other languages</h2><p class=sub>Cross-lingual cloning: the voices never recorded these languages.</p>")
        h.append(table(rep["languages"], [("language", lambda x: f"<b>{e(x['lang'])}</b>"), ("CER", lambda x: _f(x["cer"], 3)), ("UTMOSv2", lambda x: _f(x["utmos"])), ("similarity", lambda x: _f(x["sim"], 3))]))
        h.append(table(rep["language_voices"], [("voice", lambda x: f"<b>{e(x['voice'])}</b>"), ("CER", lambda x: _f(x["cer"], 3)), ("UTMOSv2", lambda x: _f(x["utmos"])), ("similarity", lambda x: _f(x["sim"], 3))]) + "</section>")
    if rep.get("knobs"):
        h.append("<section id=knobs><h2>Quality settings</h2><p class=sub>Guidance (cfg) and diffusion steps, averaged over two voices.</p>")
        h.append(table(rep["knobs"], [("setting", lambda k: f"<b>{e(k['setting'])}</b>"), ("judge 1-9", lambda k: _f(k["judge"])), ("UTMOSv2", lambda k: _f(k["utmos"])),
                                      ("WER", lambda k: _f(k["wer"], 3)), ("RTF", lambda k: _f(k["rtf"]))]) + "</section>")
    lf = rep["sections"].get("longform", [])
    if lf:
        h.append("<section id=longform><h2>Long-form</h2>" + table(lf, realism_cols, judge_notes=True) + "</section>")
    h.append("</main>")
    (jd / "report.html").write_text("\n".join(h), encoding="utf-8")
