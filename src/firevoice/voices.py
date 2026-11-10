"""Voice library: ~/.firevoice/voices/<id>/  (override with FIREVOICE_HOME)

    ref.wav        reference clip, 24 kHz mono, 6-20 s, loudness-normalised   (cloning engines)
    ref.txt        exact transcript of ref.wav (transcribed on add; ICL engines clone better with it)
    refs/<style>.wav[.txt]   optional per-style references (a horror take, a hype take, ...)
    meta.json      voice_id, name, gender, description (used by voice-design engines), tags, source,
                   license, consent, created, styles

A voice must either have a clip you have the right to use (adding one requires `consent=True`, recorded in
meta.json) or be a *designed* voice: a description with no clip, which only design-capable engines can
speak. `firevoice voices design` renders a designed voice to a clip so every engine can clone it.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Optional

import numpy as np

from .paths import home as _home
import soundfile as sf

from . import audio as A

DEFAULT = "default"
REF_SR = 24000


_META_LOCK = threading.RLock()      # read-modify-write of meta.json from several request threads
STYLE_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,40}")


def _style_ok(style: Optional[str]) -> Optional[str]:
    """A style name used to build a file path: only plain names (no '..', slashes or drive letters) get through."""
    return style if style and STYLE_NAME.fullmatch(style) else None


def write_json_atomic(path: Path, obj, ensure_ascii: bool = False) -> None:
    """Write JSON via a temp file and rename: a crash or a concurrent writer never leaves half a file behind."""
    path = Path(path)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=ensure_ascii), encoding="utf-8")
    os.replace(tmp, path)


def write_text_atomic(path: Path, text: str) -> None:
    """Text via a temp file and rename (a crash never leaves half a transcript)."""
    path = Path(path)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def write_wav_atomic(path: Path, data, sr: int) -> None:
    """A 16-bit WAV via a temp file and rename."""
    path = Path(path)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp.wav")
    sf.write(str(tmp), data, sr, subtype="PCM_16", format="WAV")
    os.replace(tmp, path)


def back_up_unreadable(path: Path) -> Optional[Path]:
    """Move a file that cannot be read aside (name.corrupt-<time>), so nothing overwrites it and it can be recovered."""
    path = Path(path)
    if not path.exists():
        return None
    dst = path.with_name(f"{path.name}.corrupt-{time.strftime('%Y%m%d-%H%M%S')}")
    try:
        os.replace(path, dst)
        return dst
    except OSError:
        return None


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", s.lower()).strip("-") or "voice"


def _resample(a: np.ndarray, sr: int, to: int) -> np.ndarray:
    if sr == to:
        return a
    n = int(len(a) * to / sr)
    return np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)


class VoiceLibrary:
    def __init__(self, root: Optional[str | Path] = None):
        self.root = (Path(root) if root else _home()) / "voices"

    # -- listing -------------------------------------------------------------------
    def list(self) -> list[dict]:
        out: list[dict] = []
        if self.root.exists():
            for d in sorted(self.root.iterdir()):
                m = d / "meta.json"
                if m.exists():
                    try:
                        meta = json.loads(m.read_text(encoding="utf-8"))
                    except Exception:
                        continue
                    meta["has_ref"] = (d / "ref.wav").exists()
                    meta["styles"] = sorted(p.stem for p in (d / "refs").glob("*.wav")) if (d / "refs").exists() else []
                    out.append(meta)
        return out

    def canonical(self, key: str) -> str:
        """Voice id for an id or a display name ("lib-f-4992" or "Rachel"); unknown keys come back unchanged."""
        if not key or key == DEFAULT or key.startswith("design:") or (self.root / _slug(key) / "meta.json").exists():
            return key
        k = key.strip().lower()
        if self.root.exists():
            for m in self.root.glob("*/meta.json"):
                try:
                    meta = json.loads(m.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if k == str(meta.get("name", "")).lower():
                    return meta["voice_id"]
        return key

    def list_styles(self, voice_id: str) -> list[str]:
        voice_id = self.canonical(voice_id)
        d = self.root / _slug(voice_id) / "refs"
        return sorted(p.stem for p in d.glob("*.wav")) if d.exists() else []

    def get(self, voice_id: str) -> dict:
        voice_id = self.canonical(voice_id)
        d = self.root / _slug(voice_id)
        m = d / "meta.json"
        if not m.exists():
            raise KeyError(f"unknown voice {voice_id!r}")
        meta = json.loads(m.read_text(encoding="utf-8"))
        meta["dir"] = str(d)
        return meta

    def exists(self, voice_id: str) -> bool:
        return (self.root / _slug(self.canonical(voice_id)) / "meta.json").exists()

    def ref_path(self, voice_id: str, style: Optional[str] = None) -> Optional[str]:
        if voice_id in (DEFAULT, "", None):
            return None
        voice_id = self.canonical(voice_id)
        d = self.root / _slug(voice_id)
        if not (d / "meta.json").exists():
            raise KeyError(f"unknown voice {voice_id!r}")
        style = _style_ok(style)
        if style and (d / "refs" / f"{style}.wav").exists():
            return str(d / "refs" / f"{style}.wav")
        p = d / "ref.wav"
        return str(p) if p.exists() else None

    def ref_text(self, voice_id: str, style: Optional[str] = None) -> Optional[str]:
        voice_id = self.canonical(voice_id)
        d = self.root / _slug(voice_id)
        cands = []
        style = _style_ok(style)
        if style:
            cands.append(d / "refs" / f"{style}.txt")
        cands.append(d / "ref.txt")
        for c in cands:
            if c.exists():
                return c.read_text(encoding="utf-8").strip()
        return None

    def resolve(self, voice_id: str, *, needs_reference: bool, engine: str = "", style: Optional[str] = None) -> dict:
        """What the engine pool needs for a voice name: {voice_id, ref, ref_text, desc}.
        `design:<description>` is an ad-hoc designed voice (no library entry) for design-capable engines."""
        vid = voice_id or DEFAULT
        if vid.startswith("design:"):
            desc = vid[len("design:"):].strip()
            if needs_reference:
                raise ValueError(f"engine {engine or '?'} cannot speak from a description; use a design-capable engine (voxcpm2, qwen3-tts-design, maya1)")
            import hashlib
            return {"voice_id": "design-" + hashlib.sha1(desc.encode()).hexdigest()[:10], "ref": None, "ref_text": None, "desc": desc}
        if vid == DEFAULT:
            d = self.default_id()
            if d is None:
                if needs_reference:
                    raise ValueError("this engine needs a reference voice: `firevoice voices add --name narrator --ref clip.wav --consent` then --voice narrator (or `firevoice voices default narrator`)")
                return {"voice_id": DEFAULT, "ref": None, "ref_text": None, "desc": None}
            vid = d
        vid = self.canonical(vid)
        meta = self.get(vid)
        ref = self.ref_path(vid, style)
        if ref is None and needs_reference:
            raise ValueError(f"voice {vid!r} has no reference clip and engine {engine or '?'} cannot speak from a description; run `firevoice voices design {vid}` first")
        return {"voice_id": f"{_slug(vid)}:{style}" if style and ref and style in meta.get("styles", []) else _slug(vid), "ref": ref,
                "ref_text": self.ref_text(vid, style), "desc": meta.get("description") or None}

    # -- default --------------------------------------------------------------------
    def set_default(self, voice_id: str) -> None:
        voice_id = self.canonical(voice_id)
        self.get(voice_id)
        self.root.mkdir(parents=True, exist_ok=True)
        write_text_atomic(self.root / "default.txt", _slug(voice_id))

    def default_id(self) -> Optional[str]:
        f = self.root / "default.txt"
        if f.exists():
            vid = f.read_text(encoding="utf-8").strip()
            if self.exists(vid):
                return vid
        voices = [v for v in self.list() if v.get("has_ref")]
        return voices[0]["voice_id"] if len(voices) == 1 else None

    def default_ref(self) -> Optional[str]:
        d = self.default_id()
        return self.ref_path(d) if d else None

    # -- mutation --------------------------------------------------------------------
    def add(self, name: str, ref_wav: Optional[str | Path] = None, *, consent: bool = False, description: str = "", gender: str = "",
            tags: Optional[list[str]] = None, source: str = "", license: str = "", transcript: Optional[str] = None, transcribe: bool = True,
            max_seconds: float = 20.0, extra: Optional[dict] = None) -> dict:
        """`extra` holds free metadata kept in meta.json (language, accent, age, dataset stats...)."""
        vid = _slug(name)
        extra = {k: v for k, v in (extra or {}).items() if v not in (None, "")}
        d = self.root / vid
        if ref_wav is None:
            if not description:
                raise ValueError("a voice needs a reference clip or a description")
            d.mkdir(parents=True, exist_ok=True)
            meta = {"voice_id": vid, "name": name, "category": "designed", "description": description, "gender": gender, "tags": tags or [],
                    "source": source or "designed", "license": license, "consent": True, "created": int(time.time()), **extra}
            write_json_atomic(d / "meta.json", meta)
            return meta
        if not consent:
            raise PermissionError("Refusing to add a voice without consent=True. Only clone voices you own or have written permission to use.")
        data, sr = sf.read(str(ref_wav), dtype="float32", always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
        data = _resample(np.asarray(data, dtype=np.float32), sr, REF_SR)
        data = A.trim_silence(data, REF_SR)
        if len(data) / REF_SR < 3:
            raise ValueError("Reference clip is too short after trimming silence; use 6-20 s of clean speech.")
        data = data[: int(REF_SR * max_seconds)]
        peak = float(np.abs(data).max()) or 1.0
        data = data / peak * 0.9
        d.mkdir(parents=True, exist_ok=True)
        write_wav_atomic(d / "ref.wav", data, REF_SR)
        if transcript is None and transcribe:
            transcript = self._transcribe(data, REF_SR)
        if transcript:
            write_text_atomic(d / "ref.txt", transcript.strip())
        meta = {"voice_id": vid, "name": name, "category": "cloned", "description": description, "gender": gender, "tags": tags or [], "source": source,
                "license": license, "consent": True, "created": int(time.time()), "ref_seconds": round(len(data) / REF_SR, 2), **extra}
        write_json_atomic(d / "meta.json", meta)
        return meta

    def add_style_ref(self, voice_id: str, style: str, ref_wav: str | Path, transcript: Optional[str] = None, transcribe: bool = True) -> str:
        d = self.root / _slug(voice_id)
        if not (d / "meta.json").exists():
            raise KeyError(f"unknown voice {voice_id!r}")
        data, sr = sf.read(str(ref_wav), dtype="float32", always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
        data = A.trim_silence(_resample(np.asarray(data, dtype=np.float32), sr, REF_SR), REF_SR)[: REF_SR * 20]
        data = data / (float(np.abs(data).max()) or 1.0) * 0.9
        (d / "refs").mkdir(exist_ok=True)
        p = d / "refs" / f"{_slug(style)}.wav"
        write_wav_atomic(p, data, REF_SR)
        if transcript is None and transcribe:
            transcript = self._transcribe(data, REF_SR)
        if transcript:
            write_text_atomic(p.with_suffix(".txt"), transcript.strip())
        return str(p)

    def update(self, voice_id: str, **fields) -> dict:
        voice_id = self.canonical(voice_id)
        d = self.root / _slug(voice_id)
        with _META_LOCK:
            meta = self.get(voice_id)
            meta.pop("dir", None)
            meta.update({k: v for k, v in fields.items() if v is not None})
            write_json_atomic(d / "meta.json", meta)
        return meta

    def remove(self, voice_id: str) -> None:
        d = self.root / _slug(self.canonical(voice_id))
        if d.exists():
            shutil.rmtree(d)

    # -- helpers ----------------------------------------------------------------------
    _asr = None

    # set by the service so adding a voice reuses the Whisper model it already has, instead of loading a second one
    transcriber = None

    def _transcribe(self, data: np.ndarray, sr: int) -> str:
        try:
            if self.transcriber is not None:
                return str(self.transcriber(data, sr) or "")
            if VoiceLibrary._asr is None:
                from .asr import FasterWhisperAligner
                VoiceLibrary._asr = FasterWhisperAligner()
            text, _ = VoiceLibrary._asr.transcribe_text(data, sr)
            return text
        except Exception as e:
            import sys
            sys.stderr.write(f"[firevoice] could not transcribe the reference clip ({type(e).__name__}: {e}); add a transcript by hand\n")
            return ""
