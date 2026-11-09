"""Showcase: render a plan of sections (voices x styles x texts x variants) into a browsable sample set.

A plan is a JSON file:

    {"title": "...", "engine": "voxcpm2",
     "texts": {"intro": "plain text", "ur": {"text": "...", "lang": "ur", "title": "Urdu script"}},
     "sections": [
       {"id": "gallery", "title": "Voice gallery", "about": "...",
        "voices": ["@cloned"],                  # ids, "@cloned", "@designed", "@tag:x", "@lang:ur", "@gender:male",
                                                #   "@prefix:glb-", "design:<description>", {"name": "...", "design": "..."}
        "limit": 0,                             # cap on selected voices (0 = all), picked evenly across the list
        "styles": ["conversational"],           # style names; text "@sample" means each style's showcase paragraph
        "texts": ["intro"],
        "variants": [{"label": "clone", "set": {"ultimate": false}}, {"label": "ultimate", "set": {"ultimate": true}}],
        "lock": false}                          # design sections: keep each render as a reusable library voice
     ]}

Every item renders through the normal Synthesizer (chunking, ASR-validated takes for English, studio chain), so
what you hear is what `firevoice say` would produce. Rendering resumes: existing files are kept unless --force.
"""
from __future__ import annotations

import dataclasses
import hashlib
import html
import json
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from . import audio as A
from .styles import Style, get_style
from .voices import VoiceLibrary

STYLE_FIELDS = {f.name for f in dataclasses.fields(Style)} - {"name", "extra"}


@dataclass
class Item:
    id: str
    section: str
    voice: str            # library id or "design:<description>"
    voice_label: str
    style: str
    text_key: str
    text: str
    lang: Optional[str]
    variant: str
    overrides: dict = field(default_factory=dict)
    lock_as: Optional[str] = None


def _slug(s: str, n: int = 40) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:n] or "x"


# ------------------------------------------------------------------------------------------------ voice selection
def select_voices(spec: list, lib: VoiceLibrary, limit: int = 0) -> list[tuple[str, str]]:
    """-> [(voice, label)] in plan order, de-duplicated."""
    all_v = lib.list()
    out: list[tuple[str, str]] = []
    seen = set()

    def add(v: str, label: str):
        if v not in seen:
            seen.add(v)
            out.append((v, label))

    for s in spec:
        if isinstance(s, dict):
            add("design:" + s["design"], s.get("name") or _slug(s["design"], 24))
            continue
        if s.startswith("design:"):
            add(s, _slug(s[7:], 24))
            continue
        if not s.startswith("@"):
            add(s, s)
            continue
        key, _, val = s[1:].partition(":")
        for m in all_v:
            ok = {"cloned": m.get("has_ref", False),
                  "designed": "designed" in m.get("tags", []) or m.get("category") == "designed",
                  "tag": val in m.get("tags", []),
                  "lang": (m.get("language") or ("en" if m.get("has_ref") and not any(t.startswith("lang:") for t in m.get("tags", [])) else "")) == val,
                  "gender": m.get("gender") == val,
                  "prefix": m["voice_id"].startswith(val)}.get(key, False)
            if ok and m.get("has_ref", False) or (ok and key == "designed"):
                add(m["voice_id"], m["voice_id"])
    if limit and len(out) > limit:   # spread the pick over the whole list (keeps accent / gender variety)
        step = len(out) / limit
        out = [out[int(i * step)] for i in range(limit)]
    return out


# ------------------------------------------------------------------------------------------------ expansion
def expand_section(sec: dict, plan: dict, lib: VoiceLibrary) -> list[Item]:
    texts = plan.get("texts", {})
    voices = select_voices(sec.get("voices", ["@cloned"]), lib, int(sec.get("limit", 0)))
    styles = sec.get("styles") or ["conversational"]
    tkeys = sec.get("texts") or ["@sample"]
    variants = sec.get("variants") or [{"label": "default"}]
    items = []
    for v, vlabel in voices:
        for st in styles:
            for tk in tkeys:
                if tk == "@sample":
                    text, lang = get_style(st).sample or get_style("explainer").sample, "en"
                else:
                    t = texts.get(tk, tk)
                    text, lang = (t["text"], t.get("lang")) if isinstance(t, dict) else (t, None)
                for var in variants:
                    over = dict(sec.get("set", {}))
                    over.update(var.get("set", {}))
                    parts = [vlabel, st if len(styles) > 1 else "", tk if len(tkeys) > 1 else "", var["label"] if len(variants) > 1 else ""]
                    iid = "__".join(_slug(p) for p in parts if p)
                    lock = f"{sec.get('lock_prefix', 'dsg')}-{_slug(vlabel, 30)}" if sec.get("lock") and v.startswith("design:") else None
                    items.append(Item(iid, sec["id"], v, vlabel, st, tk, text, lang, var["label"], over, lock))
    return items


def _custom_style(item: Item) -> Style:
    base = get_style(item.style)
    fields = {k: v for k, v in item.overrides.items() if k in STYLE_FIELDS}
    extra = {**base.extra, **{k: v for k, v in item.overrides.items() if k not in STYLE_FIELDS}}
    return dataclasses.replace(base, extra=extra, **fields)


# ------------------------------------------------------------------------------------------------ render
def render(plan_path: str, out: str, *, engine: Optional[str] = None, workers: Optional[int] = None, parallel: int = 2,
           force: bool = False, sections: Optional[list[str]] = None, fmt: str = "mp3", seed: int = 1234, lufs: float = -16.0,
           asr: bool = True, log=print) -> dict:
    from .asr import FasterWhisperAligner, NullAligner
    from .core.pool import EnginePool
    from .synth import Synthesizer

    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    engine = engine or plan.get("engine", "voxcpm2")
    outd = Path(out)
    outd.mkdir(parents=True, exist_ok=True)
    idx_path = outd / "index.json"
    prev = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.exists() else {}
    results: dict[str, dict] = {r["key"]: r for r in prev.get("items", []) if "key" in r}
    lib = VoiceLibrary()
    pool = EnginePool(engine, workers=workers)
    aligner = FasterWhisperAligner("auto") if asr else NullAligner()
    synth = Synthesizer(pool, aligner, lib)
    lock = threading.Lock()
    t_all = time.time()
    done = {"n": 0}

    def save():
        with lock:
            items = sorted(results.values(), key=lambda r: (r.get("order", 0)))
            idx_path.write_text(json.dumps({"title": plan.get("title"), "engine": engine, "plan": str(plan_path), "sections": plan["sections"],
                                            "texts": plan.get("texts", {}), "items": items}, indent=1, ensure_ascii=False), encoding="utf-8")
            write_html(outd, plan, items, engine, lib)

    try:
        pool.start()
        order = 0
        for sec in plan["sections"]:
            if sections and sec["id"] not in sections:
                continue
            items = expand_section(sec, plan, lib)   # expanded now, so voices locked by earlier sections are included
            log(f"== {sec['id']}: {len(items)} item(s)")
            _copy_refs(outd, {it.voice for it in items}, lib)

            def one(job):
                n, it = job
                key = f"{it.section}/{it.id}"
                dst = outd / it.section / f"{it.id}.{fmt}"
                rec = {"key": key, "order": n, "section": it.section, "id": it.id, "voice": it.voice, "voice_label": it.voice_label,
                       "style": it.style, "text_key": it.text_key, "variant": it.variant, "lang": it.lang, "overrides": it.overrides,
                       "file": f"{it.section}/{it.id}.{fmt}"}
                if dst.exists() and not force and key in results and not results[key].get("error"):
                    results[key]["order"] = n
                    return
                try:
                    r = synth.speak(it.text, voice=it.voice, custom_style=_custom_style(it), seed=seed, lufs=lufs or None, lang=it.lang)
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    A.write_audio(dst, r.audio, r.sr)
                    rec.update(duration=round(r.duration, 2), rtf=r.stats.rtf, wall=round(r.stats.wall_seconds, 2), takes=r.stats.takes,
                               retries=r.stats.retries, warnings=r.warnings, score=round(min((t.score for t in r.takes), default=1.0), 3))
                    if it.lock_as:
                        _lock_voice(lib, it, r)
                        rec["locked_as"] = it.lock_as
                    log(f"  {key:70} {r.duration:5.1f}s rtf={r.stats.rtf:<5} takes={r.stats.takes}")
                except Exception as e:  # one bad item never stops the showcase
                    rec["error"] = f"{type(e).__name__}: {str(e)[:300]}"
                    log(f"  {key:70} FAILED {rec['error']}")
                with lock:
                    results[key] = rec
                    done["n"] += 1
                if done["n"] % 20 == 0:
                    save()

            jobs = []
            for it in items:
                jobs.append((order, it))
                order += 1
            with ThreadPoolExecutor(max_workers=parallel) as ex:
                list(ex.map(one, jobs))
            save()
    finally:
        synth.close()
    save()
    n_err = sum(1 for r in results.values() if r.get("error"))
    log(f"{len(results)} item(s), {n_err} error(s), {time.time() - t_all:.0f}s -> {outd / 'index.html'}")
    return {"items": len(results), "errors": n_err, "seconds": round(time.time() - t_all)}


def _lock_voice(lib: VoiceLibrary, it: Item, r) -> None:
    """Design -> lock: the rendered take becomes the voice's reference, so every later line (and every engine) keeps
    exactly this identity instead of re-imagining the description per sentence."""
    tmp = Path(lib.root) / f"_lock_{it.lock_as}.wav"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    A.write_audio(tmp, r.audio, r.sr)
    desc = it.voice[len("design:"):]
    g = "female" if re.search(r"\b(woman|female|girl|grandmother|lady|she)\b", desc, re.I) else "male" if re.search(r"\b(man|male|boy|grandfather|guy|he)\b", desc, re.I) else ""
    try:
        lib.add(it.lock_as, tmp, consent=True, description=desc, gender=g, tags=["designed", "designed:voxcpm2"], source="designed with voxcpm2 (locked take)",
                license="synthetic", transcript=it.text, extra={"language": it.lang or "en", "design_prompt": desc})
    finally:
        tmp.unlink(missing_ok=True)


def _copy_refs(outd: Path, voices: set, lib: VoiceLibrary) -> None:
    """Reference clips next to the page, so every row can play the original human voice beside the clone."""
    d = outd / "_refs"
    d.mkdir(exist_ok=True)
    for v in voices:
        if v.startswith("design:"):
            continue
        try:
            src = lib.ref_path(v)
        except Exception:
            src = None
        if src and not (d / f"{v}.wav").exists():
            shutil.copyfile(src, d / f"{v}.wav")


# ------------------------------------------------------------------------------------------------ page
CSS = """
:root{--bg:#0d0f13;--panel:#151821;--line:#262a35;--fg:#e9eaee;--mute:#8d93a1;--acc:#ff7a45;--ok:#4cc38a;--warn:#e5b54b;--bad:#ef5f5f}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:22px 24px 10px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(13,15,19,.96);z-index:5;backdrop-filter:blur(6px)}
h1{margin:0 0 4px;font-size:20px;font-weight:650}h1 small{color:var(--mute);font-weight:400;font-size:13px}
nav{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 6px}nav a{color:var(--fg);text-decoration:none;background:var(--panel);border:1px solid var(--line);padding:4px 10px;border-radius:999px;font-size:12.5px}
nav a:hover{border-color:var(--acc)}.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:var(--mute)}
input,select{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font:inherit}
main{padding:8px 24px 60px}section{margin-top:26px}h2{font-size:17px;margin:0 0 2px}.about{color:var(--mute);max-width:980px;margin:0 0 10px}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;min-width:100%}
th,td{border-bottom:1px solid var(--line);border-right:1px solid var(--line);padding:8px 10px;vertical-align:top;text-align:left}
th{background:var(--panel);font-weight:600;font-size:12.5px;position:sticky;top:0}td.v{min-width:230px;max-width:280px;background:#11141b}
.vn{font-weight:650}.vd{color:var(--mute);font-size:12px}.pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:#202533;color:#c9cdd8;margin:2px 3px 0 0}
audio{width:250px;height:34px;display:block}.meta{color:var(--mute);font-size:11.5px;margin-top:3px}.w{color:var(--warn)}.e{color:var(--bad);font-size:12px;max-width:250px}
.txt{color:var(--mute);font-size:12px;max-width:330px;white-space:pre-wrap}.ref audio{width:200px}.hide{display:none}
"""

JS = """
const q=document.getElementById('q'),g=document.getElementById('g'),l=document.getElementById('l');
function f(){const s=q.value.toLowerCase(),gv=g.value,lv=l.value;document.querySelectorAll('tr[data-v]').forEach(r=>{
 const ok=(!s||r.dataset.s.includes(s))&&(!gv||r.dataset.g===gv)&&(!lv||r.dataset.l===lv);r.classList.toggle('hide',!ok)})}
[q,g,l].forEach(e=>e.addEventListener('input',f));
document.addEventListener('play',e=>{document.querySelectorAll('audio').forEach(a=>{if(a!==e.target)a.pause()})},true);
"""


def write_html(outd: Path, plan: dict, items: list[dict], engine: str, lib: VoiceLibrary) -> None:
    meta = {v["voice_id"]: v for v in lib.list()}
    texts = plan.get("texts", {})
    esc = html.escape
    total = sum(r.get("duration", 0) for r in items)
    errs = sum(1 for r in items if r.get("error"))
    langs = sorted({(meta.get(r["voice"], {}).get("language") or "en") for r in items if not r["voice"].startswith("design:")})
    h = [f"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>{esc(plan.get('title', 'FireVoice showcase'))}</title><style>{CSS}</style>",
         f"<header><h1>{esc(plan.get('title', 'FireVoice showcase'))} <small>engine {esc(engine)} · {len(items)} clips · {total / 60:.0f} min of audio · {errs} errors</small></h1><nav>"]
    for sec in plan["sections"]:
        n = sum(1 for r in items if r["section"] == sec["id"])
        if n:
            h.append(f"<a href='#{sec['id']}'>{esc(sec.get('title', sec['id']))} <span class=vd>{n}</span></a>")
    h.append("</nav><div class=filters>Filter rows: <input id=q placeholder='voice, accent, description…' size=28>"
             "<select id=g><option value=''>any gender</option><option>male</option><option>female</option><option value='design'>designed</option></select>"
             "<select id=l><option value=''>any language</option>" + "".join(f"<option>{esc(x)}</option>" for x in langs) + "</select></div></header><main>")
    for sec in plan["sections"]:
        rows = [r for r in items if r["section"] == sec["id"]]
        if not rows:
            continue
        h.append(f"<section id='{sec['id']}'><h2>{esc(sec.get('title', sec['id']))}</h2><p class=about>{esc(sec.get('about', ''))}</p>")
        cols: list[tuple] = []
        for r in rows:
            c = (r["style"], r["text_key"], r["variant"])
            if c not in cols:
                cols.append(c)
        vary = [len({c[i] for c in cols}) > 1 for i in range(3)]
        h.append("<div class=wrap><table><tr><th>voice</th><th>original</th>")
        for c in cols:
            label = " · ".join(_col_label(c[i], i, texts) for i in range(3) if vary[i]) or _col_label(c[1], 1, texts)
            tip = ""
            if vary[1] or not any(vary):
                t = texts.get(c[1], c[1])
                tip = (t["text"] if isinstance(t, dict) else t) if c[1] != "@sample" else ""
            h.append(f"<th title='{esc(tip)}'>{esc(label)}</th>")
        h.append("</tr>")
        by_v: dict[str, dict] = {}
        for r in rows:
            by_v.setdefault(r["voice"], {})[(r["style"], r["text_key"], r["variant"])] = r
        for v, cells in by_v.items():
            m = meta.get(v, {})
            any_r = next(iter(cells.values()))
            designed = v.startswith("design:")
            g = "design" if designed else m.get("gender", "")
            lang = m.get("language") or ("" if designed else "en")
            desc = v[7:] if designed else m.get("description", "")
            pills = "".join(f"<span class=pill>{esc(x)}</span>" for x in [g, lang, m.get("license", ""), m.get("accent_code", "")] if x)
            search = " ".join([v, desc, m.get("accent", ""), g, lang]).lower()
            h.append(f"<tr data-v='{esc(v)}' data-g='{esc(g)}' data-l='{esc(lang)}' data-s='{esc(search)}'><td class=v><div class=vn>{esc(any_r['voice_label'])}</div>"
                     f"<div class=vd>{esc(desc)}</div>{pills}</td>")
            ref = outd / "_refs" / f"{v}.wav"
            h.append(f"<td class=ref>{'<audio controls preload=none src=' + chr(39) + '_refs/' + esc(v) + '.wav' + chr(39) + '></audio>' if ref.exists() else '<span class=vd>designed</span>'}</td>")
            for c in cols:
                r = cells.get(c)
                if not r:
                    h.append("<td></td>")
                elif r.get("error"):
                    h.append(f"<td><div class=e>{esc(r['error'][:160])}</div></td>")
                else:
                    warn = f" · <span class=w>{len(r.get('warnings', []))} warn</span>" if r.get("warnings") else ""
                    knobs = ", ".join(f"{k}={v2}" for k, v2 in r.get("overrides", {}).items() if k not in ("instruct",))
                    h.append(f"<td><audio controls preload=none src='{esc(r['file'])}'></audio><div class=meta>{r.get('duration', '')}s · rtf {r.get('rtf', '')}"
                             f" · takes {r.get('takes', '')}{warn}{(' · ' + esc(knobs)) if knobs else ''}</div></td>")
            h.append("</tr>")
        h.append("</table></div></section>")
    h.append(f"</main><script>{JS}</script>")
    (outd / "index.html").write_text("\n".join(h), encoding="utf-8")


def _col_label(v: str, axis: int, texts: dict) -> str:
    if axis == 1:
        t = texts.get(v)
        if isinstance(t, dict) and t.get("title"):
            return t["title"]
        return "style sample" if v == "@sample" else v
    if axis == 0:
        try:
            return get_style(v).title or v
        except KeyError:
            return v
    return v


def plan_digest(path: str) -> str:
    return hashlib.sha1(Path(path).read_bytes()).hexdigest()[:10]
