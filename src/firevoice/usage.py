"""Usage: every operation FireVoice performs, one line each, and the numbers built from them.

  <home>/usage/events.jsonl    {"t", "kind", "status", "engine", "voice", "style", "language", "chars", "words",
                                "audio_s", "proc_s", ...}

kinds: speech, sound, music, changer, dialogue, transcript, dub, separate, clean, voice (a new voice), design (a
designed voice). status: done | failed | cancelled. The log is append-only; a line that cannot be read is skipped.
On first use it is seeded from what is already on disk (kept renders, history, jobs), so past work counts too.

`instrument(svc)` wraps the service's operations; calls made inside another tracked operation in the same thread (the
speech turns of a dub, the cues of a dialogue) are not counted twice, and the dialogue's own speech turns carry a
marker for the same reason.
"""
from __future__ import annotations

import functools
import json
import os
import threading
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Optional

_LOCK = threading.Lock()
_DEPTH = threading.local()
INNER = "_usage_inner"          # set on a TTSRequest that is part of a larger tracked operation


def _file() -> Path:
    from .paths import home
    return home() / "usage" / "events.jsonl"


def record(kind: str, status: str = "done", **fields: Any) -> None:
    """Append one event. Never raises: tracking must not break the work it tracks."""
    ev = {"t": round(time.time(), 3), "kind": kind, "status": status}
    ev.update({k: v for k, v in fields.items() if v is not None and v != ""})
    try:
        f = _file()
        f.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(ev, ensure_ascii=False, default=str) + "\n"
        with _LOCK, open(f, "a", encoding="utf-8") as fh:
            fh.write(line)
        _CACHE.clear()
    except Exception:
        pass


def events() -> list[dict]:
    f = _file()
    if not f.exists():
        return []
    out = []
    with open(f, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                ev = json.loads(line)
                if isinstance(ev, dict) and "t" in ev and "kind" in ev:
                    out.append(ev)
            except Exception:
                continue
    return out


def _words(text: str) -> int:
    return len([w for w in (text or "").split() if any(c.isalnum() for c in w)])


# ------------------------------------------------------------------------------------------------ instrumentation
def _speech(svc, args, kwargs, r) -> Optional[dict]:
    req = args[0] if args else kwargs.get("req")
    if req is None or getattr(req, INNER, False):
        return None
    info = r.info() if hasattr(r, "info") else {}
    text = getattr(req, "text", "") or ""
    return {"kind": "speech", "engine": info.get("engine") or getattr(r, "engine", None), "voice": req.voice, "style": req.style,
            "language": getattr(req, "language", None) or getattr(getattr(r, "result", None), "language", None),
            "chars": len(text), "words": _words(text), "audio_s": round(float(getattr(r, "duration", 0) or 0), 3),
            "proc_s": round(float(getattr(r, "seconds", 0) or 0), 3), "takes": info.get("takes"), "retries": info.get("retries"),
            "sentences": info.get("chunks"), "kept": bool(info.get("render_id"))}


def _sound(svc, args, kwargs, r) -> dict:
    a, sr, info = r
    kind = args[1] if len(args) > 1 else kwargs.get("kind", "sfx")
    return {"kind": "music" if kind == "music" else "sound", "engine": info.get("engine"), "audio_s": round(len(a) / sr, 3),
            "proc_s": info.get("seconds"), "chars": len(args[0] if args else kwargs.get("prompt", ""))}


def _changer(svc, args, kwargs, r) -> dict:
    out, sr = r
    return {"kind": "changer", "engine": "chatterbox-vc", "voice": args[1] if len(args) > 1 else kwargs.get("voice"), "audio_s": round(len(out) / sr, 3)}


def _dialogue(svc, args, kwargs, r) -> dict:
    sr = r.get("sr") or 1
    turns = r.get("turns") or []
    script = args[0] if args else kwargs.get("script", "")
    return {"kind": "dialogue", "audio_s": round(len(r.get("audio", [])) / sr, 3), "chars": len(script or ""), "words": _words(script),
            "speakers": len(r.get("cast") or {}), "turns": len(turns), "engine": ((kwargs.get("defaults") or {}).get("engine"))}


def _transcribe(svc, args, kwargs, r) -> dict:
    return {"kind": "transcript", "language": r.get("language"), "audio_s": r.get("duration"), "proc_s": r.get("seconds"),
            "words": len(r.get("words") or []), "chars": len(r.get("text") or ""), "diarize": bool(kwargs.get("diarize"))}


def _dub(svc, args, kwargs, r) -> dict:
    sr = r.get("sr") or 1
    return {"kind": "dub", "language": args[1] if len(args) > 1 else kwargs.get("target"), "audio_s": round(len(r.get("audio", [])) / sr, 3),
            "lines": len(r.get("lines") or []), "source_language": r.get("source_language")}


def _separate(svc, args, kwargs, r) -> dict:
    voice, rest, sr = r
    return {"kind": "separate", "audio_s": round(len(voice) / sr, 3), "mode": args[1] if len(args) > 1 else kwargs.get("mode", "vocals")}


def _clean(svc, args, kwargs, r) -> dict:
    out, sr, _check = r
    return {"kind": "clean", "audio_s": round(len(out) / sr, 3)}


def _voice_add(svc, args, kwargs, r) -> dict:
    return {"kind": "voice", "voice": (r or {}).get("voice_id"), "language": kwargs.get("language") or None}


def _voice_design(svc, args, kwargs, r) -> dict:
    return {"kind": "design", "voice": (r or {}).get("voice_id"), "engine": kwargs.get("engine")}


TRACKED: dict[str, tuple[str, Callable]] = {
    "tts": ("speech", _speech),
    "sound": ("sound", _sound),
    "voice_convert": ("changer", _changer),
    "dialogue": ("dialogue", _dialogue),
    "transcribe": ("transcript", _transcribe),
    "dub": ("dub", _dub),
    "audio_separate": ("separate", _separate),
    "audio_clean": ("clean", _clean),
    "voice_add": ("voice", _voice_add),
    "voice_design": ("design", _voice_design),
    "design_keep": ("design", _voice_design),
}


def instrument(svc) -> None:
    """Wrap the service's operations so each finished, failed or cancelled one leaves an event."""
    if getattr(svc, "_usage_on", False):
        return
    svc._usage_on = True
    for name, (kind, extract) in TRACKED.items():
        fn = getattr(svc, name, None)
        if fn is None:
            continue
        setattr(svc, name, _wrap(svc, fn, kind, extract))
    threading.Thread(target=seed, daemon=True, name="fv-usage-seed").start()


def _wrap(svc, fn, kind, extract):
    @functools.wraps(fn)
    def run(*args, **kwargs):
        depth = getattr(_DEPTH, "n", 0)
        if depth:                                   # part of a larger tracked operation in this thread
            return fn(*args, **kwargs)
        _DEPTH.n = 1
        t0 = time.perf_counter()
        try:
            r = fn(*args, **kwargs)
        except BaseException as e:
            name = type(e).__name__
            status = "cancelled" if name in ("Cancelled", "CancelledError") else "failed"
            req = args[0] if (kind == "speech" and args) else None
            if not (req is not None and getattr(req, INNER, False)):
                record(kind, status, error=str(e)[:200], proc_s=round(time.perf_counter() - t0, 3),
                       engine=getattr(req, "engine", None) if req is not None else kwargs.get("engine"))
            raise
        finally:
            _DEPTH.n = 0
        try:
            ev = extract(svc, args, kwargs, r)
            if ev:
                ev.setdefault("proc_s", round(time.perf_counter() - t0, 3))
                k = ev.pop("kind", kind)
                record(k, "done", **ev)
        except Exception:
            pass
        return r
    return run


# ------------------------------------------------------------------------------------------------ seeding
def seed() -> None:
    """First run only: turn what is already on disk into events, so past work shows up in the numbers."""
    f = _file()
    if f.exists():
        return
    from .paths import home
    h = home()
    out: list[dict] = []
    for rj in sorted((h / "takes").glob("*/render.json")):
        try:
            m = json.loads(rj.read_text(encoding="utf-8"))
            req = m.get("request") or {}
            dur = sum(next((t.get("duration") or 0 for t in c.get("takes", []) if t.get("n") == c.get("chosen")), 0) for c in m.get("chunks", []))
            text = req.get("text") or ""
            out.append({"t": m.get("created"), "kind": "speech", "status": "done", "engine": m.get("engine"), "voice": req.get("voice"),
                        "style": req.get("style"), "language": req.get("language"), "chars": len(text), "words": _words(text),
                        "audio_s": round(dur, 3), "sentences": len(m.get("chunks", [])), "kept": True, "seeded": True})
        except Exception:
            continue
    for ij in sorted((h / "history").glob("*/item.json")):
        try:
            m = json.loads(ij.read_text(encoding="utf-8"))
            meta = m.get("meta") or {}
            out.append({"t": m.get("created"), "kind": m.get("kind"), "status": "done", "audio_s": m.get("duration"),
                        "engine": meta.get("engine"), "voice": meta.get("voice"), "language": meta.get("language"),
                        "words": meta.get("words"), "seeded": True})
        except Exception:
            continue
    for jj in sorted((h / "renders").glob("*/job.json")):
        try:
            j = json.loads(jj.read_text(encoding="utf-8"))
            if j.get("kind") in ("dub",) and j.get("status") == "done":
                res = j.get("result") or {}
                out.append({"t": j.get("finished") or j.get("created"), "kind": "dub", "status": "done", "language": (j.get("payload") or {}).get("target"),
                            "audio_s": res.get("duration"), "proc_s": j.get("elapsed"), "seeded": True})
            elif j.get("status") in ("failed", "cancelled"):
                kind = {"tts": "speech", "dub": "dub", "dialogue": "dialogue", "design": "design"}.get(j.get("kind"), j.get("kind"))
                out.append({"t": j.get("finished") or j.get("created"), "kind": kind, "status": j.get("status"), "seeded": True,
                            "error": ((j.get("error") or {}).get("message") or "")[:200]})
        except Exception:
            continue
    out = [{k: v for k, v in e.items() if v is not None and v != ""} for e in out if e.get("t") and e.get("kind")]
    out.sort(key=lambda e: e["t"])
    try:
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".seed.tmp")
        tmp.write_text("".join(json.dumps(e, ensure_ascii=False, default=str) + "\n" for e in out), encoding="utf-8")
        with _LOCK:
            if f.exists():                          # an event landed while seeding: keep it after the seeded ones
                tmp.write_text(tmp.read_text(encoding="utf-8") + f.read_text(encoding="utf-8"), encoding="utf-8")
            os.replace(tmp, f)
        _CACHE.clear()
    except Exception:
        pass


# ------------------------------------------------------------------------------------------------ summary
_CACHE: dict = {}
GROUP = {"speech": "speech", "dialogue": "dialogue", "sound": "sound", "music": "sound", "changer": "changer", "dub": "dub",
         "transcript": "transcript", "separate": "tools", "clean": "tools"}
GROUPS = ["speech", "dialogue", "sound", "changer", "dub", "transcript", "tools"]


def _day(t: float) -> str:
    return datetime.fromtimestamp(t).strftime("%Y-%m-%d")


def summary(days: Optional[int] = 30) -> dict:
    """Every number for the Stats screen, for the last `days` days (0 or None: all time)."""
    f = _file()
    key = (days, f.stat().st_mtime if f.exists() else 0, f.stat().st_size if f.exists() else 0)
    if _CACHE.get("key") == key:
        return _CACHE["value"]
    evs = events()
    now = time.time()
    since = now - days * 86400 if days else 0
    sel = [e for e in evs if e["t"] >= since]
    done = [e for e in sel if e.get("status") == "done"]

    def s(es, field):
        return round(sum(float(e.get(field) or 0) for e in es), 3)

    speech = [e for e in done if e["kind"] == "speech"]
    made = [e for e in done if e["kind"] in ("speech", "dialogue", "sound", "music", "changer", "dub")]
    trans = [e for e in done if e["kind"] == "transcript"]
    timed = [e for e in speech if (e.get("proc_s") or 0) > 0 and (e.get("audio_s") or 0) > 0]
    failed = sum(1 for e in sel if e.get("status") == "failed")
    cancelled = sum(1 for e in sel if e.get("status") == "cancelled")

    totals = {
        "operations": len(sel), "done": len(done), "failed": failed, "cancelled": cancelled,
        "success_rate": round(len(done) / max(1, len(done) + failed), 4),
        "speech_renders": len(speech), "audio_made_s": s(made, "audio_s"), "speech_s": s(speech, "audio_s"),
        "chars": int(s(speech, "chars") + s([e for e in done if e["kind"] == "dialogue"], "chars")),
        "words_spoken": int(s(speech, "words") + s([e for e in done if e["kind"] == "dialogue"], "words")),
        "transcripts": len(trans), "transcribed_s": s(trans, "audio_s"), "words_transcribed": int(s(trans, "words")),
        "sounds": sum(1 for e in done if e["kind"] == "sound"), "music": sum(1 for e in done if e["kind"] == "music"),
        "music_s": s([e for e in done if e["kind"] == "music"], "audio_s"),
        "voice_changes": sum(1 for e in done if e["kind"] == "changer"), "dialogues": sum(1 for e in done if e["kind"] == "dialogue"),
        "dubs": sum(1 for e in done if e["kind"] == "dub"), "separations": sum(1 for e in done if e["kind"] == "separate"),
        "cleanups": sum(1 for e in done if e["kind"] == "clean"),
        "voices_added": sum(1 for e in done if e["kind"] == "voice"), "voices_designed": sum(1 for e in done if e["kind"] == "design"),
        "gpu_s": s([e for e in done if e["kind"] != "voice"], "proc_s"),
        "speed": round(s(timed, "audio_s") / max(1e-6, s(timed, "proc_s")), 2) if timed else None,
        "takes": int(s(speech, "takes")), "retries": int(s(speech, "retries")), "sentences": int(s(speech, "sentences")),
    }

    by_kind = Counter()
    kind_s = defaultdict(float)
    for e in done:
        by_kind[e["kind"]] += 1
        kind_s[e["kind"]] += float(e.get("audio_s") or 0)

    def rank(field, es, top=10):
        c, a, p = Counter(), defaultdict(float), defaultdict(float)
        for e in es:
            k = e.get(field)
            if not k:
                continue
            c[k] += 1
            a[k] += float(e.get("audio_s") or 0)
            p[k] += float(e.get("proc_s") or 0)
        rows = [{"key": k, "count": n, "audio_s": round(a[k], 2), "speed": round(a[k] / p[k], 2) if p[k] > 0 and a[k] > 0 else None}
                for k, n in c.most_common(top)]
        return rows, len(c)

    engines, n_engines = rank("engine", [e for e in done if e["kind"] in ("speech", "sound", "music", "dialogue")])
    voices, n_voices = rank("voice", speech)
    styles, n_styles = rank("style", speech)
    langs, n_langs = rank("language", [e for e in done if e["kind"] in ("speech", "transcript", "dub")])

    # activity per day (audio made per group), over the range (or the last 90 days for all time)
    span = days or 90
    start = date.today() - timedelta(days=span - 1)
    daily = {(start + timedelta(days=i)).isoformat(): {"count": 0, **{g: 0.0 for g in GROUPS}} for i in range(span)}
    for e in done:
        d = _day(e["t"])
        if d in daily:
            daily[d]["count"] += 1
            g = GROUP.get(e["kind"])
            if g:
                daily[d][g] = round(daily[d][g] + float(e.get("audio_s") or 0), 2)
    heat = [[0] * 24 for _ in range(7)]
    for e in sel:
        dt = datetime.fromtimestamp(e["t"])
        heat[dt.weekday()][dt.hour] += 1

    # records and streaks (all time)
    all_done = [e for e in evs if e.get("status") == "done"]
    days_active = sorted({_day(e["t"]) for e in all_done})
    longest = cur = 0
    prev = None
    for d in days_active:
        dd = date.fromisoformat(d)
        cur = cur + 1 if prev and (dd - prev).days == 1 else 1
        longest = max(longest, cur)
        prev = dd
    streak = 0
    if days_active:
        last = date.fromisoformat(days_active[-1])
        if (date.today() - last).days <= 1:
            streak = cur
    per_day = Counter(_day(e["t"]) for e in all_done)
    busiest = per_day.most_common(1)[0] if per_day else None
    longest_speech = max((e for e in all_done if e["kind"] == "speech"), key=lambda e: e.get("audio_s") or 0, default=None)
    fastest = max((e for e in all_done if e["kind"] == "speech" and (e.get("proc_s") or 0) > 0 and (e.get("audio_s") or 0) >= 3),
                  key=lambda e: (e.get("audio_s") or 0) / e["proc_s"], default=None)
    records = {
        "first_use": min((e["t"] for e in evs), default=None), "active_days": len(days_active), "streak": streak, "longest_streak": longest,
        "busiest_day": {"date": busiest[0], "count": busiest[1]} if busiest else None,
        "longest_speech_s": longest_speech.get("audio_s") if longest_speech else None,
        "fastest_speed": round((fastest.get("audio_s") or 0) / fastest["proc_s"], 2) if fastest else None,
        "all_time_audio_s": round(sum(float(e.get("audio_s") or 0) for e in all_done if e["kind"] in ("speech", "dialogue", "sound", "music", "changer", "dub")), 2),
        "all_time_operations": len(evs),
    }
    errors = Counter((e.get("error") or "unknown")[:120] for e in sel if e.get("status") == "failed").most_common(5)
    value = {
        "range": {"days": days or 0, "since": since or (evs[0]["t"] if evs else None), "until": now},
        "totals": totals,
        "by_kind": [{"kind": k, "count": n, "audio_s": round(kind_s[k], 2)} for k, n in by_kind.most_common()],
        "engines": engines, "engines_used": n_engines, "voices": voices, "voices_used": n_voices,
        "styles": styles, "styles_used": n_styles, "languages": langs, "languages_used": n_langs,
        "daily": [{"date": d, **v} for d, v in daily.items()], "groups": GROUPS, "heatmap": heat,
        "records": records, "errors": [{"message": m, "count": n} for m, n in errors],
    }
    _CACHE["key"], _CACHE["value"] = key, value
    return value
