"""Build judge/clips.json from a showcase folder: one entry per rendered clip with everything the scorers need."""
from __future__ import annotations

import json
import re
from pathlib import Path

from ..styles import get_style
from ..voices import VoiceLibrary

MARKUP = re.compile(r"\[(?:pause[^\]]*|laugh|chuckle|sigh|gasp|cough|clear throat|sniff|groan|giggle|hmm)\]", re.I)


def plain(text: str) -> str:
    return re.sub(r"\s{2,}", " ", MARKUP.sub(" ", text)).strip()


def build(samples_dir: str | Path) -> dict:
    d = Path(samples_dir)
    idx = json.loads((d / "index.json").read_text(encoding="utf-8"))
    texts = idx.get("texts", {})
    lib = VoiceLibrary()
    meta = {v["voice_id"]: v for v in lib.list()}

    def text_of(key: str) -> tuple[str, str | None]:
        t = texts.get(key, key)
        return (t["text"], t.get("lang")) if isinstance(t, dict) else (t, None)

    clips = []
    for r in idx["items"]:
        if r.get("error") or not (d / r["file"]).exists():
            continue
        if r["text_key"] == "@sample":
            text, lang = get_style(r["style"]).sample, "en"
        else:
            text, lang = text_of(r["text_key"])
        lang = r.get("lang") or lang or "en"
        # every Urdu rendering says the same Urdu words, whatever script it was written in: score it against Urdu
        asr_lang, asr_ref = lang, plain(text)
        if r["text_key"].startswith("ur_"):
            asr_lang, asr_ref = "ur", plain(text_of("ur_script")[0])
        v = r["voice"]
        m = meta.get(v, {})
        ref = None
        if not v.startswith("design:"):
            try:
                ref = lib.ref_path(v)
            except Exception:
                ref = None
        clips.append({
            "key": r["key"], "file": str((d / r["file"]).resolve()), "section": r["section"], "voice": v, "voice_label": r["voice_label"],
            "style": r["style"], "text_key": r["text_key"], "variant": r["variant"], "text": plain(text), "lang": lang,
            "asr_lang": asr_lang, "asr_ref": asr_ref, "ref": ref, "gender": m.get("gender", "design" if v.startswith("design:") else ""),
            "voice_lang": m.get("language", "en"), "accent": m.get("accent", ""), "source": m.get("source", ""), "license": m.get("license", ""),
            "description": v[7:] if v.startswith("design:") else m.get("description", ""), "duration": r.get("duration"), "rtf": r.get("rtf"),
            "overrides": r.get("overrides", {}),
        })
    out = d / "judge"
    out.mkdir(exist_ok=True)
    doc = {"samples": str(d.resolve()), "engine": idx.get("engine"), "clips": clips}
    (out / "clips.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
    return doc
