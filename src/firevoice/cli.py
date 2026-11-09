"""FireVoice command line. The everyday commands (say, batch, voices, engines, styles, transcribe, serve) run through
the same FireVoice service as the HTTP API, so every option means the same thing in both; add --remote URL to send
the request to a running `firevoice serve` instead (models stay loaded between commands)."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from . import audio as A
from .styles import all_styles, get_style
from .voices import VoiceLibrary

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ENGINE = os.environ.get("FIREVOICE_ENGINE", "voxcpm2")


# ----------------------------------------------------------------------------- shared option groups
def _tts_options(p: argparse.ArgumentParser, with_output: bool = True) -> None:
    g = p.add_argument_group("voice and delivery")
    g.add_argument("--engine", default=None, help=f"engine (default {DEFAULT_ENGINE}); see `firevoice engines`")
    g.add_argument("--voice", default="default", help="voice id (`firevoice voices list`) or 'design:<description>'")
    g.add_argument("--design", default=None, metavar="DESCRIPTION", help="speak with a voice invented from this description (design-capable engines)")
    g.add_argument("--style", default="conversational", help="delivery style: " + ", ".join(sorted(all_styles())))
    g.add_argument("--pace", type=float, default=1.0, help="tempo multiplier (0.25-4)")
    g.add_argument("--instruct", default=None, help="delivery instruction for instruction-following engines ('' = none; default: the style's)")
    g.add_argument("--language", default=None, help="ISO language code (default: detect from the text)")
    g.add_argument("--param", action="append", default=[], metavar="KEY=VALUE", help="engine parameter, repeatable (see `firevoice engines info NAME`)")
    g.add_argument("--set", dest="style_set", action="append", default=[], metavar="FIELD=VALUE",
                   help="override a style field, repeatable: temperature, cfg, pause, exaggeration, top_p...")
    g.add_argument("--seed", type=int, default=1234)
    q = p.add_argument_group("quality")
    q.add_argument("--candidates", type=int, default=1, help="takes per sentence, the best is kept (1-8)")
    q.add_argument("--accept", type=float, default=0.9, help="ASR agreement a take needs to count as validated")
    q.add_argument("--no-asr", action="store_true", help="skip ASR validation and retries")
    q.add_argument("--lufs", type=float, default=-16.0, help="loudness target; 0 = raw output without the studio chain")
    q.add_argument("--lead-ms", type=int, default=120)
    q.add_argument("--tail-ms", type=int, default=280)
    if with_output:
        o = p.add_argument_group("output")
        o.add_argument("--format", default=None, choices=list(A.FORMATS), help="audio format (default: from the output file extension)")
        o.add_argument("--sample-rate", type=int, default=None, help="resample the output (default: engine native)")
    r = p.add_argument_group("server")
    r.add_argument("--remote", nargs="?", const=os.environ.get("FIREVOICE_URL", "http://127.0.0.1:8787"), default=None, metavar="URL",
                   help="send the request to a running `firevoice serve` (default URL $FIREVOICE_URL or http://127.0.0.1:8787)")
    r.add_argument("--token", default=None, help="API token for --remote")


def _kv(items: list[str], what: str) -> dict:
    out = {}
    for it in items:
        if "=" not in it:
            raise SystemExit(f"{what} must look like KEY=VALUE, got {it!r}")
        k, v = it.split("=", 1)
        try:
            out[k.strip()] = json.loads(v)
        except ValueError:
            out[k.strip()] = v
    return out


def _request_dict(a, text: str) -> dict:
    voice = f"design:{a.design}" if a.design else a.voice
    return {"text": text, "engine": a.engine, "voice": voice, "style": a.style, "pace": a.pace, "seed": a.seed, "language": a.language,
            "instruct": a.instruct, "params": _kv(a.param, "--param"), "style_overrides": _kv(a.style_set, "--set"),
            "lufs": a.lufs or None, "candidates": a.candidates, "accept": a.accept, "validate": not a.no_asr, "lead_ms": a.lead_ms, "tail_ms": a.tail_ms,
            "dictionary": json.loads(Path(a.dict).read_text(encoding="utf-8")) if getattr(a, "dict", None) else None,
            "keep_takes": bool(getattr(a, "keep_takes", False))}


def _service(a, **kw):
    from .service import FireVoice
    return FireVoice(default_engine=getattr(a, "engine", None) or DEFAULT_ENGINE, **kw)


def _read_text(t: str) -> str:
    if t == "-":
        return sys.stdin.read()
    if t.startswith("@"):
        return Path(t[1:]).read_text(encoding="utf-8")
    return t


def _fmt_for(out: Path, fmt: str | None) -> str:
    if fmt:
        return fmt
    ext = out.suffix.lower().lstrip(".")
    return {"pcm": "pcm16"}.get(ext, ext) if ext in {v[2] for v in A.FORMATS.values()} or ext in A.FORMATS else "wav"


def _fail(e) -> int:
    from .service import FireVoiceError
    msg = e.message if isinstance(e, FireVoiceError) else getattr(e, "message", str(e))
    code = getattr(e, "code", "error")
    print(f"error ({code}): {msg}", file=sys.stderr)
    return 2 if code in ("bad_request", "not_found") else 1


# ----------------------------------------------------------------------------- everyday commands
def cmd_say(a) -> int:
    from .service import FireVoiceError, TTSRequest
    text = _read_text(a.text)
    out = Path(a.out)
    fmt = _fmt_for(out, a.format)
    body = _request_dict(a, text)
    if a.remote:
        from .client import Client, ClientError
        try:
            data, info = Client(a.remote, a.token).tts(**{**body, "format": fmt, "sample_rate": a.sample_rate})
        except ClientError as e:
            return _fail(e)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        print(f"{out}: {info.get('duration', '?')}s via {a.remote} ({info.get('engine')}, rtf {info.get('rtf')}, {info.get('warnings', 0)} warning(s))")
        return 0
    svc = _service(a)
    try:
        req = TTSRequest.from_dict(body)
        total = {"n": 0}

        def progress(c):
            if c.get("final") or c["total"] < 3:
                return
            total["n"] = c["index"] + 1
            print(f"\r  sentence {c['index'] + 1}/{c['total']}", end="", file=sys.stderr, flush=True)

        r = svc.tts(req, on_chunk=progress)
        if total["n"]:
            print(file=sys.stderr)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(svc.encode(r, fmt, a.sample_rate))
        info = r.info()
        if not a.no_words:
            out.with_suffix(".words.json").write_text(json.dumps(info["words"], indent=1), encoding="utf-8")
        for fmt_s in ("srt", "vtt"):
            dest = getattr(a, fmt_s, None)
            if dest:
                text_s, _ = svc.subtitles(info["words"], fmt_s)
                Path(dest).write_text(text_s, encoding="utf-8")
        if info.get("render_id") and not a.json:
            print(f"  kept every take as render {info['render_id']} (firevoice renders show {info['render_id']})", file=sys.stderr)
        if a.json:
            info.pop("words")
            print(json.dumps({"file": str(out), **info}, indent=1))
        else:
            print(f"{out}: {r.duration:.1f}s, {info['engine']}, rtf {info['rtf']}, {info['takes']} takes for {info['chunks']} sentence(s), "
                  f"{len(info['warnings'])} warning(s)")
            for w in info["warnings"]:
                print("  warn:", w, file=sys.stderr)
        return 0
    except FireVoiceError as e:
        return _fail(e)
    finally:
        svc.close()


def cmd_dict(a) -> int:
    from .service import FireVoiceError
    svc = _service(a)
    try:
        if a.action == "list":
            rules = svc.dictionary_view()["rules"]
            if not rules:
                print("no rules yet: firevoice dict add MATCH SAY   (built-in list: firevoice dict builtin)")
            for r in rules:
                opts = ", ".join(x for x in ("case" if r["case"] else "", "anywhere" if not r["whole_word"] else "") if x)
                print(f"{r['id']}  {r['match']!r:24} -> {r['say']!r}{'  (' + opts + ')' if opts else ''}{'  # ' + r['note'] if r['note'] else ''}")
        elif a.action == "builtin":
            for r in svc.dictionary_view()["builtin"]:
                print(f"{r['match']!r:16} -> {r['say']!r}")
        elif a.action == "add":
            if len(a.args) != 2:
                print("usage: firevoice dict add MATCH SAY [--case] [--anywhere] [--note TEXT]", file=sys.stderr)
                return 2
            r = svc.dictionary_add({"match": a.args[0], "say": a.args[1], "case": a.case, "whole_word": not a.anywhere, "note": a.note})
            print(f"added {r['id']}: {r['match']!r} -> {r['say']!r}")
        elif a.action == "remove":
            for rid in a.args:
                svc.dictionary_remove(rid)
                print("removed", rid)
        elif a.action == "test":
            r = svc.dictionary_test(" ".join(a.args), a.engine, a.language)
            print(r["spoken"])
        elif a.action == "export":
            dest = a.args[0] if a.args else "dictionary.json"
            Path(dest).write_text(json.dumps({"rules": svc.dictionary_view()["rules"]}, indent=1, ensure_ascii=False), encoding="utf-8")
            print("wrote", dest)
        elif a.action == "import":
            data = json.loads(Path(a.args[0]).read_text(encoding="utf-8"))
            rules = data.get("rules", data) if isinstance(data, dict) else data
            if isinstance(rules, dict):
                rules = [{"match": k, "say": v} for k, v in rules.items()]
            print(f"imported {len(svc.dictionary_replace(rules)['rules'])} rule(s)")
        return 0
    except FireVoiceError as e:
        return _fail(e)
    finally:
        svc.close()


def cmd_renders(a) -> int:
    from .service import FireVoiceError
    svc = _service(a)
    try:
        if a.action == "list":
            for r in svc.render_list(a.limit):
                flag = f", {r['flagged']} flagged" if r["flagged"] else ""
                print(f"{r['id']}  {r['passages']} passage(s), {r['takes']} take(s){flag}  {r['voice']} / {r['style']}  {r['title']!r}")
            return 0
        if not a.id:
            print("which render? (firevoice renders list)", file=sys.stderr)
            return 2
        if a.action == "show":
            m = svc.render_get(a.id)
            for ch in m["chunks"]:
                mark = ("LOCKED " if ch["locked"] else "") + ("FLAGGED " if ch["flagged"] else "")
                print(f"[{ch['index']}] {mark}{ch['text'][:90]}")
                for t in ch["takes"]:
                    used = "*" if t["n"] == ch["chosen"] else " "
                    qa = t.get("qa") or {}
                    issues = [w["text"] + ("->" + w["heard"] if w.get("heard") else "") for w in qa.get("words", []) if w["status"] != "ok"]
                    print(f"   {used} take {t['n']}: score {t['score']}, {t['duration']}s, seed {t['seed']}"
                          + (f", missed/changed: {' '.join(issues)}" if issues else "") + (f", heard extra: {' '.join(qa['extra'])}" if qa.get("extra") else ""))
        elif a.action == "take":
            m = svc.render_retake(a.id, a.passage, a.seed)
            ch = next(c for c in m["chunks"] if c["index"] == a.passage)
            t = ch["takes"][-1]
            print(f"passage {a.passage}: new take {t['n']} (score {t['score']}){', now used' if ch['chosen'] == t['n'] else ''}")
        elif a.action == "choose":
            svc.render_choose(a.id, a.passage, a.take)
            print(f"passage {a.passage} uses take {a.take}")
        elif a.action in ("lock", "unlock"):
            svc.render_lock(a.id, a.passage, a.action == "lock")
            print(f"passage {a.passage} {a.action}ed")
        elif a.action == "regenerate":
            svc.render_regenerate(a.id, [a.passage] if a.passage is not None else None)
            print("new takes made for", f"passage {a.passage}" if a.passage is not None else "every unlocked passage")
        elif a.action == "export":
            out = Path(a.out or f"{a.id}.wav")
            audio, sr, words = svc.render_audio(a.id)
            out.write_bytes(svc.encode(audio, _fmt_for(out, None), sr=sr))
            print(f"{out}: {len(audio) / sr:.1f}s")
        elif a.action == "subtitles":
            out = Path(a.out or f"{a.id}.srt")
            _a, _sr, words = svc.render_audio(a.id)
            out.write_text(svc.subtitles(words, out.suffix.lstrip(".") or "srt")[0], encoding="utf-8")
            print("wrote", out)
        elif a.action == "delete":
            svc.render_delete(a.id)
            print("deleted", a.id)
        return 0
    except FireVoiceError as e:
        return _fail(e)
    finally:
        svc.close()


def cmd_project(a) -> int:
    from .service import FireVoiceError
    svc = _service(a)
    try:
        if a.action == "list":
            for p in svc.project_list():
                c = p["counts"]
                print(f"{p['id']}  {p['title']!r}: {p['chapters']} chapter(s), {p['paragraphs']} paragraph(s), {p['words']} words, "
                      f"{c['rendered'] + c['locked']} rendered, {c['stale']} changed, {c['draft']} draft, {p['duration'] / 60:.1f} min")
            return 0
        if a.action == "new":
            defaults = {k: v for k, v in (("voice", a.voice), ("style", a.style), ("engine", a.engine)) if v}
            p = svc.project_create(a.id or "Untitled project", _read_text(a.text) if a.text else "", defaults)
            print(f"created {p['id']}: {len(p['chapters'])} chapter(s), {p['paragraphs']} paragraph(s)")
            return 0
        if a.action == "import":
            p = svc.project_import(Path(a.id).read_bytes())
            print(f"imported {p['id']}: {p['title']!r}")
            return 0
        if not a.id:
            print("which project? (firevoice project list)", file=sys.stderr)
            return 2
        if a.action == "show":
            p = svc.project_get(a.id)
            print(f"{p['title']}  ({p['words']} words, {p['duration'] / 60:.1f} min rendered)")
            for ch in p["chapters"]:
                print(f"\n[{ch['id']}] {ch['title']}")
                for para in ch["paragraphs"]:
                    extra = ", ".join(f"{k} {para[k]}" for k in ("voice", "style", "pace") if para.get(k))
                    print(f"  {para['id']}  {para['status']:8}  {para['text'][:80]!r}{'  (' + extra + ')' if extra else ''}")
        elif a.action == "render":
            if a.para:
                svc.paragraph_render(a.id, a.para)
                print("rendered", a.para)
            else:
                todo = svc.project_todo(a.id, "all" if a.all else "stale", a.chapter)
                if not todo:
                    print("nothing to render: every paragraph is up to date (or locked)")
                for k, (_ch, para) in enumerate(todo, 1):
                    print(f"\r  paragraph {k}/{len(todo)}", end="", file=sys.stderr, flush=True)
                    svc.paragraph_render(a.id, para)
                if todo:
                    print(file=sys.stderr)
                    print(f"rendered {len(todo)} paragraph(s)")
        elif a.action in ("lock", "unlock"):
            svc.paragraph_lock(a.id, a.para, a.action == "lock")
            print(f"{a.para} {a.action}ed")
        elif a.action == "export":
            out = Path(a.out or f"{a.id}.m4b")
            fmt = out.suffix.lower().lstrip(".") or "mp3"
            data, _mt, _name = svc.project_export(a.id, {"pcm": "pcm16"}.get(fmt, fmt), a.chapter, a.master)
            out.write_bytes(data)
            print(f"wrote {out} ({len(data) // 1024} KB)")
        elif a.action == "check":
            r = svc.project_check(a.id, a.master)
            for ch in r["chapters"]:
                print(f"{'PASS' if ch['pass'] else 'FAIL'}  {ch['title']}")
                for c in ch.get("checks", []):
                    print(f"   {'ok ' if c['ok'] else 'NO '} {c['name']}: {c['value']} {c['unit']} (want {c['target']})")
            return 0 if r["pass"] else 1
        elif a.action == "bundle":
            data, name = svc.project_bundle(a.id)
            out = Path(a.out or name)
            out.write_bytes(data)
            print(f"wrote {out} ({len(data) // 1024 // 1024} MB)")
        elif a.action == "delete":
            svc.project_delete(a.id)
            print("deleted", a.id)
        return 0
    except FireVoiceError as e:
        return _fail(e)
    finally:
        svc.close()


def cmd_batch(a) -> int:
    """Lines from a JSON file ([{"id", "text", <any request field>}...] or {"lines": [...]}) rendered in parallel."""
    from concurrent.futures import ThreadPoolExecutor
    from .service import FireVoiceError, TTSRequest

    data = json.loads(Path(a.file).read_text(encoding="utf-8"))
    lines = data["lines"] if isinstance(data, dict) else data
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    fmt = a.format or "wav"
    ext = A.FORMATS[fmt][2]
    defaults = _request_dict(a, "")
    defaults.pop("text")
    manifest_path = out / "manifest.json"
    old = {m["id"]: m for m in json.loads(manifest_path.read_text(encoding="utf-8"))} if manifest_path.exists() else {}
    svc = _service(a)
    t0 = time.time()

    def one(item):
        i, line = item
        lid = str(line.get("id") or i + 1)
        dst = out / f"{lid}.{ext}"
        if dst.exists() and not a.force and lid in old and old[lid].get("text") == line["text"]:
            return {**old[lid], "skipped": True}
        try:
            r = svc.tts(TTSRequest.from_dict({**defaults, **{k: v for k, v in line.items() if k != "id"}}))
        except FireVoiceError as e:
            print(f"{lid:12} FAILED {e.code}: {e.message}", flush=True)
            return {"id": lid, "text": line.get("text"), "error": {"code": e.code, "message": e.message}}
        dst.write_bytes(svc.encode(r, fmt, a.sample_rate))
        info = r.info()
        (out / f"{lid}.words.json").write_text(json.dumps(info.pop("words"), indent=1), encoding="utf-8")
        print(f"{lid:12} {r.duration:5.1f}s  rtf {info['rtf']}  {len(info['warnings'])} warning(s)", flush=True)
        return {"id": lid, "text": line["text"], "file": dst.name, **info}

    try:
        with ThreadPoolExecutor(max_workers=max(1, a.parallel)) as ex:
            manifest = list(ex.map(one, enumerate(lines)))
    finally:
        svc.close()
    manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
    bad = sum(1 for m in manifest if "error" in m)
    print(f"{len(manifest)} line(s), {sum(m.get('duration', 0) for m in manifest):.0f}s of audio in {time.time() - t0:.0f}s, {bad} failed -> {out}")
    return 1 if bad else 0


def cmd_voices(a) -> int:
    from .service import FireVoiceError
    if a.action == "harvest":
        return _harvest(a)
    if a.remote and a.action == "list":
        from .client import Client
        rows = Client(a.remote, a.token).voices(language=a.language, gender=a.gender, kind=a.kind, q=a.q, tag=a.tag)
        return _print_voices(rows, a)
    svc = _service(a)
    try:
        if a.action == "list":
            return _print_voices(svc.voice_list(language=a.language, gender=a.gender, tag=a.tag, q=a.q, kind=a.kind), a)
        if a.action == "pack":
            data, name = svc.voice_pack(a.name)
            out = Path(a.pack or name)
            out.write_bytes(data)
            print(f"wrote {out} ({len(data) // 1024} KB)")
            return 0
        if a.action == "import":
            if not a.pack:
                print("usage: firevoice voices import --pack FILE.zip --consent [--name ID]", file=sys.stderr)
                return 2
            v = svc.voice_import(Path(a.pack).read_bytes(), consent=a.consent, voice_id=a.name)
            print(f"added {v['voice_id']} ({v.get('name') or ''})")
            return 0
        if a.action == "brand":
            only = [x.strip() for x in (a.only or "").split(",") if x.strip()] or None
            rows = svc.voice_brand(a.report, force=a.force, log=print, only=only)
            print(f"{len(rows)} voice(s) branded")
            return 0
        if a.action == "previews":
            ids = [a.name] if a.name else [v["voice_id"] for v in svc.voice_list() if v.get("has_ref")]
            todo = [i for i in ids if a.force or not svc.voice(i).get("has_preview")]
            print(f"rendering {len(todo)} preview(s) ({len(ids) - len(todo)} already done)")
            for i, vid in enumerate(todo, 1):
                try:
                    r = svc.voice_render_preview(vid, engine=a.engine)
                    print(f"  {i:3}/{len(todo)} {vid:22} {r['name']:12} {r['preview_seconds']}s")
                except FireVoiceError as e:
                    print(f"  {i:3}/{len(todo)} {vid:22} FAILED {e.message}")
            return 0
        if not a.name:
            print(f"voices {a.action} needs --name", file=sys.stderr)
            return 2
        if a.action == "info":
            print(json.dumps(svc.voice(a.name), indent=1, ensure_ascii=False))
        elif a.action == "add":
            if a.ref:
                v = svc.voice_add(a.name, a.ref, consent=a.consent, description=a.description or "", gender=a.gender or "", language=a.language or "",
                                  accent=a.accent or "", tags=a.tags.split(",") if a.tags else None, transcript=a.transcript, source=a.source or "",
                                  license=a.license or "")
            elif a.description:   # description only: design it now with a design-capable engine and lock the take
                v = svc.voice_design(a.name, a.description, engine=a.engine, text=a.text, gender=a.gender or "", language=a.language or "")
            else:
                print("voices add needs --ref clip.wav --consent, or --description '...' to design a voice", file=sys.stderr)
                return 2
            print(json.dumps(v, indent=1, ensure_ascii=False))
        elif a.action == "design":
            meta = svc.voices.get(a.name) if svc.voices.exists(a.name) and not a.description else None
            desc = a.description or (meta or {}).get("description")
            if not desc:
                print("voices design needs --description", file=sys.stderr)
                return 2
            backup = None
            if meta:   # an old description-only entry: replace it with a locked, designed voice, but keep it until that works
                import shutil
                old_dir = Path(meta["dir"])
                backup = old_dir.with_name(old_dir.name + ".replacing")
                shutil.move(str(old_dir), str(backup))
            try:
                v = svc.voice_design(a.name, desc, engine=a.engine, text=a.text, gender=a.gender or "", language=a.language or "")
            except Exception:
                if backup is not None:
                    shutil.move(str(backup), str(old_dir))     # put the old entry back
                raise
            if backup is not None:
                shutil.rmtree(backup, ignore_errors=True)
            print(json.dumps(v, indent=1))
        elif a.action == "update":
            fields = {k: getattr(a, k) for k in ("description", "gender", "language", "accent", "tagline") if getattr(a, k)}
            if a.tags:
                fields["tags"] = [t for t in a.tags.split(",") if t]
            if a.rename:
                fields["name"] = a.rename
            v = svc.voice_update(a.name, **fields)
            if a.transcript:
                v = svc.voice_set_transcript(a.name, a.transcript)
            print(json.dumps(v, indent=1, ensure_ascii=False))
        elif a.action == "remove":
            print(json.dumps(svc.voice_remove(a.name)))
        elif a.action == "default":
            svc.voice_set_default(a.name)
            print(f"default voice: {a.name}")
        elif a.action == "style-ref":
            if not (a.style_name and a.ref):
                print("usage: firevoice voices style-ref --name VOICE --style-name horror --ref clip.wav", file=sys.stderr)
                return 2
            print(json.dumps(svc.voice_add_style_ref(a.name, a.style_name, a.ref, a.transcript), indent=1))
        return 0
    except FireVoiceError as e:
        return _fail(e)
    finally:
        svc.close()


def _print_voices(rows: list[dict], a) -> int:
    if a.json:
        print(json.dumps(rows, indent=1, ensure_ascii=False))
        return 0
    for v in rows:
        flags = ("*" if v.get("default") else " ") + (" designed" if v.get("kind") == "designed" else "")
        styles = f"  styles: {','.join(v['styles'])}" if v.get("styles") else ""
        tier = (v.get("quality") or {}).get("tier") or "-"
        print(f"{flags[:1]} {v['voice_id']:22} {str(v.get('name') or ''):12} {tier:2} {v.get('gender') or '-':7} {v.get('language') or 'en':3} "
              f"{(v.get('tagline') or v.get('description') or '')[:64]}{styles}")
    print(f"{len(rows)} voice(s)" + ("  (* = default)" if any(v.get("default") for v in rows) else ""))
    return 0


def _harvest(a) -> int:
    from .harvest import DATASETS, harvest, harvest_commonvoice, harvest_fleurs, harvest_globe
    lib = VoiceLibrary()
    if a.dataset == "globe_v2" and a.shards:
        got = harvest_globe(a.shards, lib=lib, max_voices=a.max, per_accent=a.per_accent, prefix=a.prefix or "glb", min_snr=a.min_snr,
                            accents=a.accents.split(",") if a.accents else None)
    elif a.dataset == "commonvoice" and a.shards:
        got = harvest_commonvoice(a.shards[0], lib=lib, language=a.language or "xx", lang_name=a.lang_name or a.language or "unknown", repo=a.repo,
                                  max_voices=a.max, per_gender=a.per_gender, prefix=a.prefix or "", min_snr=a.min_snr, split=a.cv_split)
    elif a.dataset == "fleurs" and a.shards:
        got = harvest_fleurs(a.shards[0], lib=lib, language=a.language or "xx", lang_name=a.lang_name or a.language or "unknown", max_voices=a.max,
                             prefix=a.prefix or "", min_snr=a.min_snr)
    elif a.dataset in DATASETS and a.shards:
        got = harvest(a.dataset, a.shards, lib=lib, max_voices=a.max, prefix=a.prefix or "", per_gender=a.per_gender, min_snr=a.min_snr,
                      styles=a.styles.split(",") if a.styles else None)
    else:
        print(f"usage: firevoice voices harvest --dataset {{{','.join([*DATASETS, 'globe_v2', 'fleurs', 'commonvoice'])}}} --shards PATH...", file=sys.stderr)
        return 2
    print(f"{len(got)} voice(s) added to {lib.root}")
    return 0


def cmd_engines(a) -> int:
    from .service import FireVoiceError
    if a.remote:
        from .client import Client
        rows = Client(a.remote, a.token).engines()
    else:
        svc = _service(a)
        try:
            if a.action == "info":
                if not a.name:
                    print("engines info NAME", file=sys.stderr)
                    return 2
                rows = [svc.engine(a.name)]
            else:
                rows = svc.engines()
        except FireVoiceError as e:
            return _fail(e)
        finally:
            svc.close()
    if a.action == "info" and a.name:
        rows = [r for r in rows if r["name"] == a.name] or rows
    if a.json:
        print(json.dumps(rows if a.action != "info" else rows[0], indent=1))
        return 0
    if a.action == "info":
        e = rows[0]
        print(f"{e['name']}  ({e['title']})  {'ready' if e['ready'] else 'NOT READY: ' + '; '.join(e['problems'])}")
        print(f"  licence {e['license']} ({'commercial ok' if e['commercial'] else 'non-commercial'}), {e['sample_rate']} Hz, ~{e['vram_gb']} GB VRAM per worker"
              + (f", measured RTF {e['speed_rtf']}" if e.get("speed_rtf") else ""))
        caps = [k for k in ("clone", "design", "instruct", "tags", "needs_transcript") if e.get(k)]
        print(f"  can: {', '.join(caps) or '-'};  languages: {', '.join(e['languages']) or '-'}")
        if e.get("presets"):
            print(f"  presets: {', '.join(e['presets'])}")
        if e.get("notes"):
            print(f"  {e['notes']}")
        print("  parameters (--param KEY=VALUE):" if e["params"] else "  no engine-specific parameters")
        for p in e["params"]:
            rng = f"{p['min']}..{p['max']}" if p.get("min") is not None else (", ".join(map(str, p["choices"])) if p.get("choices") else "")
            print(f"    {p['name']:22} {p['type']:7} default {str(p['default']):10} {rng:24} {p.get('help') or p.get('label') or ''}")
        return 0
    print(f"{'engine':18} {'ready':6} {'licence':26} {'comm':5} {'sr':6} {'rtf':6} {'clone':6} {'design':7} {'instr':6} languages")
    for e in rows:
        langs = "many" if "*" in e["languages"] else ",".join(e["languages"][:6]) + ("…" if len(e["languages"]) > 6 else "")
        print(f"{e['name']:18} {'yes' if e['ready'] else 'no':6} {e['license'][:26]:26} {'yes' if e['commercial'] else 'no':5} {e['sample_rate']:<6} "
              f"{str(e.get('speed_rtf') or '-'):6} {'yes' if e['clone'] else '-':6} {'yes' if e['design'] else '-':7} {'yes' if e['instruct'] else '-':6} {langs}")
    print(f"default engine: {DEFAULT_ENGINE}   (`firevoice engines info NAME` for parameters)")
    return 0


def cmd_styles(a) -> int:
    from .service import FireVoiceError
    svc = _service(a)
    try:
        if a.action == "list":
            rows = svc.style_list()
            if a.json:
                print(json.dumps(rows, indent=1, ensure_ascii=False))
                return 0
            for s in rows:
                print(f"{s['name']:15} {'built-in' if s['builtin'] else 'user':8} pace {s['pace']:<5} pause {s['pause']:<5} cfg {s['cfg']:<4} {s['description']}")
        elif a.action == "show":
            print(json.dumps(svc.style(a.name), indent=1, ensure_ascii=False))
        elif a.action == "add":
            base = svc.style(a.base) if a.base else {}
            base.pop("builtin", None)
            data = {**{k: v for k, v in base.items() if k != "name"}, **_kv(a.style_set, "--set"), "name": a.name}
            if a.description:
                data["description"] = a.description
            if a.instruct is not None:
                data["instruct"] = a.instruct
            print(json.dumps(svc.style_save(data), indent=1, ensure_ascii=False))
        elif a.action == "remove":
            print(json.dumps(svc.style_remove(a.name)))
        return 0
    except FireVoiceError as e:
        return _fail(e)
    finally:
        svc.close()


def cmd_transcribe(a) -> int:
    from .service import FireVoiceError
    if a.remote:
        from .client import Client
        c = Client(a.remote, a.token)
        results = [(f, c.stt(f, language=a.language, beam_size=a.beam)) for f in a.files]
    else:
        svc = _service(a, asr_model=a.asr_model, asr_device=a.asr_device)
        try:
            results = [(f, svc.transcribe(f, language=a.language, beam_size=a.beam)) for f in a.files]
        except FireVoiceError as e:
            return _fail(e)
        finally:
            svc.close()
    for f, r in results:
        out = Path(a.out) if a.out and len(a.files) == 1 else Path(f).with_suffix(".transcript.json")
        out.write_text(json.dumps({"file": str(f), **r}, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"{f}: {len(r['words'])} words, language {r['language']}, {r['seconds']}s ({r['model']} on {r['device']}) -> {out}")
        if a.print:
            print(r["text"])
    return 0


def cmd_serve(a) -> int:
    import uvicorn
    from .server import create_app
    from .service import FireVoice

    svc = FireVoice(default_engine=a.engine or DEFAULT_ENGINE, asr_model=a.asr_model, asr_device=a.asr_device,
                    workers={e: a.workers for e in (a.preload or "").split(",") if e} if a.workers else None)
    if a.host not in ("127.0.0.1", "localhost", "::1") and not (a.token or os.environ.get("FIREVOICE_API_KEY")):
        print("refusing to listen on a non-local address without --token (or FIREVOICE_API_KEY)", file=sys.stderr)
        return 2
    for e in [x for x in (a.preload or "").split(",") if x]:
        print(f"loading {e}...", flush=True)
        t0 = time.time()
        svc.load(e)
        print(f"  {e} ready in {time.time() - t0:.0f}s", flush=True)
    app = create_app(svc, token=a.token, cors_origins=a.cors.split(",") if a.cors else None)
    print(f"FireVoice API on http://{a.host}:{a.port}  (docs: http://{a.host}:{a.port}/docs, default engine {svc.default_engine})", flush=True)
    try:
        uvicorn.run(app, host=a.host, port=a.port, log_level=a.log_level)
    finally:
        svc.close()
    return 0


# ----------------------------------------------------------------------------- research / production tools
def build_synth(args) -> "Synthesizer":  # noqa: F821
    from .asr import FasterWhisperAligner, NullAligner
    from .frontend.normalize import load_lexicon
    from .synth import Synthesizer

    aligner = NullAligner() if args.no_asr else FasterWhisperAligner(args.asr_model, device=args.asr_device, concurrency=args.asr_threads)
    return Synthesizer(args.engine or DEFAULT_ENGINE, aligner, VoiceLibrary(), load_lexicon(args.lexicon), workers=args.workers, candidates=args.candidates,
                       accept=args.accept, cache_dir=getattr(args, "cache", None) or None)


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--engine", default=None, help=f"see `firevoice engines` (default {DEFAULT_ENGINE})")
    p.add_argument("--workers", type=int, default=None, help="model copies on the GPU (default: engine's default)")
    p.add_argument("--voice", default="default", help="a voice from `firevoice voices list`")
    p.add_argument("--style", default="conversational", help="/".join(sorted(all_styles())))
    p.add_argument("--pace", type=float, default=1.0)
    p.add_argument("--seed", type=int, default=1234)
    p.add_argument("--lufs", type=float, default=-16.0, help="target loudness; 0 disables the studio chain")
    p.add_argument("--candidates", type=int, default=1)
    p.add_argument("--accept", type=float, default=0.9)
    p.add_argument("--no-asr", action="store_true")
    p.add_argument("--asr-model", default="auto")
    p.add_argument("--asr-device", default="auto")
    p.add_argument("--asr-threads", type=int, default=2)
    p.add_argument("--lexicon", default=None, help="JSON file of extra pronunciations {written: spoken}")
    p.add_argument("--cache", default=os.environ.get("FIREVOICE_CACHE"), help="sentence-level take cache dir")


def cmd_audition(a) -> int:
    """Render one paragraph in every style (and optionally every voice) into one file, so a human can pick."""
    import numpy as np

    s = build_synth(a)
    try:
        parts, index, t = [], [], 0.0
        styles = [a.style] if a.only_style else sorted(all_styles())
        voices = [a.voice] if a.voice != "all" else [v["voice_id"] for v in VoiceLibrary().list()]
        for v in voices:
            for st in styles:
                text = a.text or get_style(st).sample or get_style("explainer").sample
                r = s.speak(text, voice=v, style=st, pace=a.pace, seed=a.seed, lufs=a.lufs or None)
                index.append({"voice": v, "style": st, "start": round(t, 2), "duration": round(r.duration, 2), "warnings": r.warnings})
                parts += [r.audio, A.silence(900, r.sr)]
                t += r.duration + 0.9
                print(f"{v:14} {st:14} {r.duration:5.1f}s  at {index[-1]['start']:6.1f}s  warnings={len(r.warnings)}")
        out = Path(a.out)
        A.write_audio(out, np.concatenate(parts), s.sr)
        out.with_suffix(".index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
        print(f"{out}: {t:.0f}s, listen and pick (index in {out.with_suffix('.index.json').name})")
    finally:
        s.close()
    return 0


def cmd_doctor(a) -> int:
    """Check the toolchain and, with --engine-test, time a smoke synthesis on the GPU."""
    import shutil

    from .core import catalog

    ok = True
    print(f"python  {sys.version.split()[0]}  ({sys.executable})")
    try:
        import torch
        print(f"torch   {torch.__version__}  cuda={torch.cuda.is_available()}  {torch.cuda.get_device_name(0) if torch.cuda.is_available() else ''}")
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            print(f"vram    {free / 1e9:.1f} GB free of {total / 1e9:.1f} GB")
    except Exception as e:
        print("torch   MISSING", e)
        ok = False
    print(f"ffmpeg  {shutil.which('ffmpeg') or 'MISSING'}")
    try:
        from .asr import cuda_available
        print(f"asr     faster-whisper cuda={cuda_available()}")
    except Exception as e:
        print("asr     MISSING", e)
    for name, inf in catalog.CATALOG.items():
        if name == "null":
            continue
        st = inf.status()
        print(f"engine  {name:18} {'ready' if st['ready'] else 'not ready: ' + '; '.join(st['problems'])}")
    lib = VoiceLibrary()
    print(f"voices  {len(lib.list())} in {lib.root}  default={lib.default_id()}")
    if a.engine_test:
        from .service import FireVoice, TTSRequest
        svc = FireVoice(default_engine=a.engine_test)
        try:
            t0 = time.time()
            svc.load(a.engine_test, a.workers)
            print(f"boot    {a.engine_test}: {svc.engine(a.engine_test)['workers']} worker(s) in {time.time() - t0:.1f}s")
            voice = "default" if svc.voices.default_id() else ("design:a clear, friendly adult narrator" if catalog.info(a.engine_test).design else "default")
            r = svc.tts(TTSRequest(text="This is a short smoke test of the engine. It should sound clean and finish quickly.", voice=voice, style="explainer", validate=False))
            print(f"smoke   {r.duration:.1f}s audio in {r.seconds:.1f}s (rtf {r.info()['rtf']}), {len(r.info()['warnings'])} warning(s)")
        except Exception as e:
            print("smoke   FAILED:", getattr(e, "message", e))
            ok = False
        finally:
            svc.close()
    return 0 if ok else 1


def cmd_samples(a) -> int:
    """Render every voice x every style (each style's showcase paragraph) into samples/<style>/<voice>.mp3 + index.html."""
    from concurrent.futures import ThreadPoolExecutor

    lib = VoiceLibrary()
    voices = a.voices.split(",") if a.voices else [v["voice_id"] for v in lib.list() if v.get("has_ref") or a.allow_designed]
    styles = a.styles.split(",") if a.styles else sorted(all_styles())
    if not voices:
        print("no voices registered; add some with `firevoice voices add`", file=sys.stderr)
        return 2
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    s = build_synth(a)
    index: list[dict] = []
    t_all = time.time()
    try:
        jobs = [(st, v) for st in styles for v in voices]

        def one(job):
            st, v = job
            dst = out / st / f"{v}.{a.format}"
            if dst.exists() and not a.force:
                return {"style": st, "voice": v, "file": str(dst.relative_to(out)), "skipped": True}
            text = get_style(st).sample or get_style("explainer").sample
            try:
                r = s.speak(text, voice=v, style=st, seed=a.seed, lufs=a.lufs or None)
                dst.parent.mkdir(parents=True, exist_ok=True)
                A.write_audio(dst, r.audio, r.sr)
                e = {"style": st, "voice": v, "file": str(dst.relative_to(out)).replace("\\", "/"), "duration": round(r.duration, 2), "rtf": r.stats.rtf,
                     "warnings": r.warnings, "min_score": min((t.score for t in r.takes), default=1.0)}
                print(f"{st:14} {v:18} {r.duration:5.1f}s  rtf={r.stats.rtf}  warnings={len(r.warnings)}", flush=True)
                return e
            except Exception as ex:
                print(f"{st:14} {v:18} FAILED {ex}", flush=True)
                return {"style": st, "voice": v, "error": str(ex)}

        with ThreadPoolExecutor(max_workers=a.parallel) as ex:
            index = list(ex.map(one, jobs))
    finally:
        s.close()
    (out / "index.json").write_text(json.dumps({"engine": a.engine or DEFAULT_ENGINE, "voices": voices, "styles": styles, "items": index}, indent=1), encoding="utf-8")
    _write_samples_html(out, voices, styles, index, a.engine or DEFAULT_ENGINE)
    print(f"{len(index)} sample(s) in {time.time() - t_all:.0f}s -> {out / 'index.html'}")
    return 0


def _write_samples_html(out: Path, voices: list[str], styles: list[str], index: list[dict], engine: str) -> None:
    by = {(e["style"], e["voice"]): e for e in index}
    vmeta = {v["voice_id"]: v for v in VoiceLibrary().list()}
    h = ["<!doctype html><meta charset=utf-8><title>FireVoice samples</title>",
         "<style>body{font:14px system-ui;margin:20px;background:#0f1115;color:#e8e8e8}h1{font-weight:600}table{border-collapse:collapse}td,th{border:1px solid #2a2d35;padding:8px;vertical-align:top}"
         "th{background:#171a21;position:sticky;top:0;text-align:left}audio{width:260px}small{color:#8a8f9a}.v{font-weight:600}.d{color:#aab;max-width:260px;font-size:12px}</style>",
         f"<h1>FireVoice samples <small>engine {engine}</small></h1><p>Rows: styles. Columns: voices. Each cell is that style's showcase paragraph.</p><table><tr><th>style</th>"]
    for v in voices:
        m = vmeta.get(v, {})
        h.append(f"<th><span class=v>{v}</span><br><small>{m.get('gender', '')}</small><div class=d>{m.get('description', '')}</div></th>")
    h.append("</tr>")
    for st in styles:
        sd = get_style(st)
        h.append(f"<tr><td><b>{sd.title or st}</b><div class=d>{sd.description}</div></td>")
        for v in voices:
            e = by.get((st, v))
            if e and e.get("file"):
                h.append(f"<td><audio controls preload=none src='{e['file']}'></audio><br><small>{e.get('duration', '')}s · rtf {e.get('rtf', '')} · {len(e.get('warnings', []))} warn</small></td>")
            else:
                h.append(f"<td><small>{(e or {}).get('error', 'missing')}</small></td>")
        h.append("</tr>")
    h.append("</table>")
    (out / "index.html").write_text("\n".join(h), encoding="utf-8")


def cmd_showcase(a) -> int:
    """Render a showcase plan (voices x styles x texts x variants, see showcase.py) into a browsable sample set."""
    from .showcase import render
    r = render(a.plan, a.out, engine=a.engine, workers=a.workers, parallel=a.parallel, force=a.force,
               sections=a.sections.split(",") if a.sections else None, fmt=a.format, seed=a.seed, lufs=a.lufs, asr=not a.no_asr)
    return 1 if r["errors"] else 0


def cmd_judge(a) -> int:
    """Automated listening test over a showcase folder (see firevoice/judge/__init__.py)."""
    import subprocess
    from .judge import manifest, metrics, report

    # "tournament" (pairwise SpeechJudge) is opt-in: on near-equal clips it mostly measures which clip played second
    stages = a.stages.split(",") if a.stages else ["manifest", "metrics", "listen", "judge", "utmos", "report"]
    judge_py = str(ROOT / ".envs" / "judge" / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))
    env = {**os.environ, "PYTHONPATH": str(ROOT / "src"), "PYTHONUNBUFFERED": "1"}
    for st in stages:
        print(f"== judge: {st}", flush=True)
        if st == "manifest":
            doc = manifest.build(a.samples)
            print(f"{len(doc['clips'])} clips -> {Path(a.samples) / 'judge' / 'clips.json'}")
        elif st == "metrics":
            metrics.run(a.samples)
        elif st in ("listen", "utmos"):
            part = "utmos" if st == "utmos" else "emotion"
            if subprocess.run([judge_py, "-X", "utf8", "-m", "firevoice.judge.listen", a.samples, part], env=env).returncode:
                return 1
        elif st == "judge":
            if subprocess.run([judge_py, "-X", "utf8", "-m", "firevoice.judge.score", a.samples, str(a.bits)], env=env).returncode:
                return 1
        elif st == "tournament":
            cmd = [judge_py, "-X", "utf8", "-m", "firevoice.judge.grm", a.samples, "--bits", str(a.bits), "--orders", str(a.orders)]
            if a.groups:
                cmd += ["--groups", a.groups]
            if subprocess.run(cmd, env=env).returncode:
                return 1
        elif st == "report":
            report.build(a.samples)
            print(f"report -> {Path(a.samples) / 'judge' / 'report.html'}")
    return 0


def cmd_bench(a) -> int:
    """Run the engine bake-off runners (each in its own venv) and score them."""
    import subprocess

    from .core import catalog
    from .core.registry import all_engines

    runners = {"chatterbox-turbo": ("run_chatterbox.py", sys.executable, []), "qwen3-tts": ("run_qwen.py", None, []), "qwen3-tts-design": ("run_qwen.py", None, ["--mode", "design"]),
               "voxcpm2": ("run_voxcpm.py", None, []), "dots": ("run_dots.py", None, []), "indextts2": ("run_indextts.py", None, []), "breeze": ("run_breeze.py", None, []),
               "omnivoice": ("run_omnivoice.py", None, []), "f5": ("run_f5.py", None, []), "kokoro": ("run_kokoro.py", None, []), "maya1": ("run_maya1.py", None, [])}
    out_names = {"chatterbox-turbo": "chatterbox", "qwen3-tts": "qwen", "qwen3-tts-design": "qwen-design", "voxcpm2": "voxcpm", "indextts2": "indextts"}

    def cuda_ok(py: str) -> bool:
        return subprocess.run([py, "-c", "import torch,sys;sys.exit(0 if torch.cuda.is_available() else 1)"], capture_output=True).returncode == 0

    engines = a.engines.split(",") if a.engines else [e for e in runners if catalog.info(e).status()["ready"]]
    for e in engines:
        script, py, extra = runners[e]
        py = py or all_engines()[e].python
        if (ROOT / "bench" / "out" / out_names.get(e, e) / "meta.json").exists() and not a.force:
            print(f"== {e}: already measured (bench/out/{out_names.get(e, e)}), use --force to redo", flush=True)
            continue
        st = catalog.info(e).status()
        if not st["ready"]:
            print(f"== {e}: not ready ({'; '.join(st['problems'])}), skipping", flush=True)
            continue
        if not cuda_ok(py):
            print(f"== {e}: its venv has no CUDA torch ({py}), skipping", flush=True)
            continue
        cmd = [py, "-X", "utf8", str(ROOT / "bench" / "runners" / script), "--ref", a.ref, *extra]
        print(f"== {e}: {' '.join(cmd[3:])}", flush=True)
        subprocess.run(cmd, cwd=str(ROOT))
    if not a.no_score:
        subprocess.run([sys.executable, "-X", "utf8", str(ROOT / "bench" / "score.py")], cwd=str(ROOT))
    return 0


# ----------------------------------------------------------------------------- parser
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="firevoice", description="FireVoice: local expressive TTS / STT with many engines, one pipeline")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("say", help="synthesize text (or @file.txt, or - for stdin) to an audio file")
    s.add_argument("text")
    s.add_argument("-o", "--out", default="out.wav", help="output file; the extension picks the format (wav, mp3, flac, ogg, opus, m4a)")
    s.add_argument("--json", action="store_true", help="print the render info as JSON")
    s.add_argument("--no-words", action="store_true", help="do not write <out>.words.json")
    s.add_argument("--srt", default=None, metavar="FILE", help="also write subtitles (SRT) to FILE")
    s.add_argument("--vtt", default=None, metavar="FILE", help="also write subtitles (WebVTT) to FILE")
    s.add_argument("--keep-takes", action="store_true", help="keep every take of every passage (see: firevoice renders)")
    s.add_argument("--dict", default=None, metavar="FILE", help="JSON pronunciation rules for this render only "
                                                                  "([{match, say}] or {written: spoken})")
    _tts_options(s)
    s.set_defaults(fn=cmd_say)

    dc = sub.add_parser("dict", help="pronunciation dictionary: your rules for how words are said")
    dc.add_argument("action", nargs="?", default="list", choices=["list", "add", "remove", "test", "import", "export", "builtin"])
    dc.add_argument("args", nargs="*", help="add: MATCH SAY | remove: ID | test: TEXT | import/export: FILE")
    dc.add_argument("--case", action="store_true", help="add: match this exact casing only")
    dc.add_argument("--anywhere", action="store_true", help="add: also match inside longer words")
    dc.add_argument("--note", default="")
    dc.add_argument("--engine", default=None, help="test: which engine's text pass to show")
    dc.add_argument("--language", default=None)
    dc.set_defaults(fn=cmd_dict)

    rd = sub.add_parser("renders", help="kept renders (say --keep-takes): compare takes, re-take, choose, lock, export")
    rd.add_argument("action", nargs="?", default="list", choices=["list", "show", "take", "choose", "lock", "unlock", "regenerate", "export", "subtitles", "delete"])
    rd.add_argument("id", nargs="?", help="render id (list shows them)")
    rd.add_argument("passage", nargs="?", type=int, help="passage index (show lists them)")
    rd.add_argument("take", nargs="?", type=int, help="choose: take number")
    rd.add_argument("-o", "--out", default=None, help="export: audio file | subtitles: .srt or .vtt file")
    rd.add_argument("--seed", type=int, default=None, help="take: seed for the new take (default: random)")
    rd.add_argument("--limit", type=int, default=30)
    rd.set_defaults(fn=cmd_renders)

    pj = sub.add_parser("project", help="long-form projects: chapters of paragraphs, render what changed, export audiobooks")
    pj.add_argument("action", nargs="?", default="list", choices=["list", "new", "show", "render", "lock", "unlock", "export", "check", "bundle", "import", "delete"])
    pj.add_argument("id", nargs="?", help="project id (list shows them); new: the title; import: the bundle file")
    pj.add_argument("para", nargs="?", help="render/lock/unlock: a paragraph id (show lists them)")
    pj.add_argument("--text", default=None, help="new: the script, or @file.txt ('# Heading' / 'Chapter 1' lines start chapters, blank lines split paragraphs)")
    pj.add_argument("--voice", default=None, help="new: default voice")
    pj.add_argument("--style", default=None, help="new: default style")
    pj.add_argument("--engine", default=None, help="new: default engine")
    pj.add_argument("--all", action="store_true", help="render: every unlocked paragraph, not only drafts and changed ones")
    pj.add_argument("--chapter", default=None, help="render/export: only this chapter id")
    pj.add_argument("--master", choices=["audiobook"], default=None, help="export/check: bring each file inside audiobook limits")
    pj.add_argument("-o", "--out", default=None, help="export: .m4b (with chapters), .mp3, .wav, .srt, .vtt | bundle: .zip")
    pj.set_defaults(fn=cmd_project)

    b = sub.add_parser("batch", help="synthesize many lines from a JSON file; every line may override any request field")
    b.add_argument("file")
    b.add_argument("-o", "--out", default="voice_out")
    b.add_argument("--force", action="store_true", help="re-render lines whose audio already exists")
    b.add_argument("--parallel", type=int, default=2, help="lines in flight at once")
    _tts_options(b)
    b.set_defaults(fn=cmd_batch)

    v = sub.add_parser("voices", help="list, add, design, update and remove voices")
    v.add_argument("action", nargs="?", default="list", choices=["list", "info", "add", "design", "update", "remove", "default", "style-ref", "harvest", "brand", "previews", "pack", "import"])
    v.add_argument("--pack", default=None, help="pack: output .zip (default <voice>.fvvoice.zip) | import: the voice pack to add")
    v.add_argument("--name")
    v.add_argument("--ref", help="add / style-ref: audio clip (6-20 s of clean speech)")
    v.add_argument("--consent", action="store_true", help="confirm you own or have permission to use this voice")
    v.add_argument("--description")
    v.add_argument("--gender", choices=["male", "female", "neutral"], default=None)
    v.add_argument("--language", default=None, help="list: filter; add/update: the voice's language (ISO code)")
    v.add_argument("--accent", default=None)
    v.add_argument("--tags", default=None, help="comma-separated")
    v.add_argument("--transcript", default=None, help="what the reference clip says (default: transcribed)")
    v.add_argument("--rename", default=None, help="update: new display name")
    v.add_argument("--tagline", default=None, help="update: one-line description shown in voice browsers")
    v.add_argument("--report", default=None, help="brand: listening-test report.json used for quality tiers")
    v.add_argument("--only", default=None, help="brand: comma-separated voices to re-brand; every other name stays as it is")
    v.add_argument("--force", action="store_true", help="brand: also rename voices you named yourself; previews: re-render existing")
    v.add_argument("--source")
    v.add_argument("--license")
    v.add_argument("--style-name", help="style-ref: the style this clip is a reference for")
    v.add_argument("--text", default=None, help="design: the line to render as the reference")
    v.add_argument("--engine", default=None, help="design: design-capable engine (default voxcpm2)")
    v.add_argument("--kind", choices=["cloned", "designed"], default=None, help="list filter")
    v.add_argument("--tag", default=None, help="list filter")
    v.add_argument("-q", "--q", default=None, help="list filter: search id, name, description, accent")
    v.add_argument("--json", action="store_true")
    v.add_argument("--remote", nargs="?", const=os.environ.get("FIREVOICE_URL", "http://127.0.0.1:8787"), default=None)
    v.add_argument("--token", default=None)
    hv = v.add_argument_group("harvest (build voices from open datasets)")
    hv.add_argument("--dataset", default=None, help="libritts_r | hifi_tts | expresso | globe_v2 | fleurs | commonvoice")
    hv.add_argument("--shards", nargs="*", default=None, help="parquet glob(s) or a local folder")
    hv.add_argument("--max", type=int, default=12)
    hv.add_argument("--per-gender", type=int, default=None)
    hv.add_argument("--per-accent", type=int, default=4)
    hv.add_argument("--accents", default=None, help="globe_v2: accent codes, e.g. us,uk,in,pk,au")
    hv.add_argument("--lang-name", default=None)
    hv.add_argument("--cv-split", default="validated")
    hv.add_argument("--repo", default=None)
    hv.add_argument("--min-snr", type=float, default=28.0)
    hv.add_argument("--styles", default=None, help="expresso: styles to keep")
    hv.add_argument("--prefix", default=None)
    v.set_defaults(fn=cmd_voices)

    e = sub.add_parser("engines", help="list engines (capabilities, licence, status) or show one engine's parameters")
    e.add_argument("action", nargs="?", default="list", choices=["list", "info"])
    e.add_argument("name", nargs="?")
    e.add_argument("--json", action="store_true")
    e.add_argument("--remote", nargs="?", const=os.environ.get("FIREVOICE_URL", "http://127.0.0.1:8787"), default=None)
    e.add_argument("--token", default=None)
    e.set_defaults(fn=cmd_engines)

    st = sub.add_parser("styles", help="list, show, add or remove delivery styles")
    st.add_argument("action", nargs="?", default="list", choices=["list", "show", "add", "remove"])
    st.add_argument("name", nargs="?")
    st.add_argument("--base", default=None, help="add: start from this style")
    st.add_argument("--set", dest="style_set", action="append", default=[], metavar="FIELD=VALUE")
    st.add_argument("--description", default=None)
    st.add_argument("--instruct", default=None)
    st.add_argument("--json", action="store_true")
    st.set_defaults(fn=cmd_styles)

    tr = sub.add_parser("transcribe", help="speech-to-text with word timestamps (GPU Whisper)")
    tr.add_argument("files", nargs="+")
    tr.add_argument("-o", "--out", default=None)
    tr.add_argument("--language", default="auto", help="ISO code or auto")
    tr.add_argument("--asr-model", default="auto")
    tr.add_argument("--asr-device", default="auto")
    tr.add_argument("--beam", type=int, default=5)
    tr.add_argument("--print", action="store_true")
    tr.add_argument("--remote", nargs="?", const=os.environ.get("FIREVOICE_URL", "http://127.0.0.1:8787"), default=None)
    tr.add_argument("--token", default=None)
    tr.set_defaults(fn=cmd_transcribe)

    sv = sub.add_parser("serve", help="run the HTTP API for the desktop app and other clients (docs at /docs)")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8787)
    sv.add_argument("--engine", default=None, help=f"default engine (default {DEFAULT_ENGINE})")
    sv.add_argument("--preload", default=None, help="comma-separated engines to load at startup")
    sv.add_argument("--workers", type=int, default=None, help="model copies per preloaded engine")
    sv.add_argument("--token", default=None, help="require this API token (also FIREVOICE_API_KEY)")
    sv.add_argument("--cors", default=None, help="comma-separated allowed origins (default: localhost and tauri)")
    sv.add_argument("--asr-model", default="auto")
    sv.add_argument("--asr-device", default="auto")
    sv.add_argument("--log-level", default="warning", choices=["critical", "error", "warning", "info", "debug"])
    sv.set_defaults(fn=cmd_serve)

    d = sub.add_parser("doctor", help="check GPU, ffmpeg, ASR, engines; --engine-test NAME runs a timed smoke synthesis")
    d.add_argument("--engine-test", default=None)
    d.add_argument("--workers", type=int, default=None)
    d.set_defaults(fn=cmd_doctor)

    au = sub.add_parser("audition", help="one paragraph in every style (and every voice with --voice all) into one file")
    au.add_argument("-o", "--out", default="audition.wav")
    au.add_argument("--text", default=None)
    au.add_argument("--only-style", action="store_true")
    _common(au)
    au.set_defaults(fn=cmd_audition)

    sm = sub.add_parser("samples", help="render every voice x every style into a samples folder with an index.html player")
    sm.add_argument("-o", "--out", default="samples")
    sm.add_argument("--voices", default=None)
    sm.add_argument("--styles", default=None)
    sm.add_argument("--format", default="mp3", choices=["mp3", "wav", "flac"])
    sm.add_argument("--parallel", type=int, default=2)
    sm.add_argument("--force", action="store_true")
    sm.add_argument("--allow-designed", action="store_true")
    _common(sm)
    sm.set_defaults(fn=cmd_samples)

    sc = sub.add_parser("showcase", help="render a showcase plan (all the modes of an engine across many voices) with an index.html player")
    sc.add_argument("plan", help="plan JSON, e.g. showcases/voxcpm2.json")
    sc.add_argument("-o", "--out", default="samples/showcase")
    sc.add_argument("--engine", default=None)
    sc.add_argument("--workers", type=int, default=None)
    sc.add_argument("--parallel", type=int, default=3)
    sc.add_argument("--sections", default=None)
    sc.add_argument("--format", default="mp3", choices=["mp3", "wav", "flac"])
    sc.add_argument("--force", action="store_true")
    sc.add_argument("--seed", type=int, default=1234)
    sc.add_argument("--lufs", type=float, default=-16.0)
    sc.add_argument("--no-asr", action="store_true")
    sc.set_defaults(fn=cmd_showcase)

    jg = sub.add_parser("judge", help="automated listening test of a showcase folder -> ranked report")
    jg.add_argument("samples")
    jg.add_argument("--stages", default=None, help="manifest,metrics,listen,judge,utmos,report (default); tournament = optional")
    jg.add_argument("--bits", type=int, default=4, choices=[4, 8, 16])
    jg.add_argument("--orders", type=int, default=1, choices=[1, 2])
    jg.add_argument("--groups", default=None)
    jg.set_defaults(fn=cmd_judge)

    bn = sub.add_parser("bench", help="bake off every installed engine on bench/texts.json -> bench/report.{md,html}")
    bn.add_argument("--engines", default=None)
    bn.add_argument("--ref", default=str(ROOT / "bench" / "refs" / "libri_m.wav"))
    bn.add_argument("--no-score", action="store_true")
    bn.add_argument("--force", action="store_true")
    bn.set_defaults(fn=cmd_bench)
    return p


def main(argv=None) -> int:
    a = build_parser().parse_args(argv)
    try:
        return a.fn(a)
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
