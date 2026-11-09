"""Portable files: a project bundle (the project and every paragraph's takes) and a voice pack (one library voice).

Both are plain zip files. Nothing in them is executable and imports check every path, so a bundle from someone else
cannot write outside its own folder.
"""
from __future__ import annotations

import io
import json
import re
import shutil
import time
import uuid
import zipfile
from pathlib import Path

MAX_BYTES = 4 * 1024 ** 3        # a bundle may hold hours of audio
VOICE_MAX_BYTES = 200 * 1024 ** 2
VOICE_FILES = re.compile(r"^(meta\.json|ref\.wav|ref\.txt|preview\.mp3|avatar\.png|refs/[a-z0-9][a-z0-9_-]{0,40}\.(wav|txt))$")


def _safe_names(z: zipfile.ZipFile, limit: int) -> list[zipfile.ZipInfo]:
    total = 0
    out = []
    for info in z.infolist():
        name = info.filename
        if info.is_dir():
            continue
        if name.startswith(("/", "\\")) or ".." in Path(name).parts or ":" in name or "\\" in name:
            raise ValueError(f"unsafe path in archive: {name!r}")
        total += info.file_size
        if total > limit:
            raise ValueError("the archive is too large")
        out.append(info)
    return out


# ---------------------------------------------------------------------- project bundles
def project_bundle(project: dict, renders_root: Path) -> bytes:
    """project.json plus renders/<id>/ (render.json and every take) for each rendered paragraph."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:     # FLAC is already compressed
        z.writestr("firevoice-project.json", json.dumps({"format": 1, "kind": "project", "exported": time.time()}))
        z.writestr("project.json", json.dumps(project, indent=1, ensure_ascii=False))
        for ch in project["chapters"]:
            for para in ch["paragraphs"]:
                r = para.get("render")
                if not r:
                    continue
                d = renders_root / r["id"]
                if not d.exists():
                    continue
                for f in d.iterdir():
                    if f.is_file():
                        z.write(f, f"renders/{r['id']}/{f.name}")
    return buf.getvalue()


def import_project_bundle(data: bytes, projects_root: Path, renders_root: Path) -> dict:
    """A new project from a bundle: new project id, new render ids (so importing twice never collides)."""
    from .voices import write_json_atomic
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos = _safe_names(z, MAX_BYTES)
        names = {i.filename for i in infos}
        if "project.json" not in names:
            raise ValueError("not a FireVoice project bundle (no project.json)")
        project = json.loads(z.read("project.json").decode("utf-8"))
        if not isinstance(project, dict) or not isinstance(project.get("chapters"), list):
            raise ValueError("project.json is not a FireVoice project")
        pid = uuid.uuid4().hex[:12]
        remap: dict[str, str] = {}
        for ch in project["chapters"]:
            for para in ch.get("paragraphs", []):
                r = para.get("render")
                if r and f"renders/{r.get('id')}/render.json" in names:
                    new = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
                    remap[r["id"]] = new
                    r["id"] = new
                elif r:
                    para["render"] = None      # its audio was not in the bundle
        for old, new in remap.items():
            d = renders_root / new
            d.mkdir(parents=True, exist_ok=True)
            for info in infos:
                if info.filename.startswith(f"renders/{old}/"):
                    name = Path(info.filename).name
                    if name == "render.json":
                        meta = json.loads(z.read(info).decode("utf-8"))
                        meta["id"], meta["pinned"] = new, pid
                        write_json_atomic(d / "render.json", meta)
                    elif re.fullmatch(r"c\d{3}_t\d+\.flac", name):
                        (d / name).write_bytes(z.read(info))
        project["id"] = pid
        project["title"] = str(project.get("title") or "Imported project") + " (imported)"
        project["updated"] = time.time()
        (projects_root / pid).mkdir(parents=True, exist_ok=True)
        write_json_atomic(projects_root / pid / "project.json", project)
        return project


# ---------------------------------------------------------------------- voice packs
def voice_pack(voice_dir: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("firevoice-voice.json", json.dumps({"format": 1, "kind": "voice", "exported": time.time()}))
        for f in sorted(voice_dir.rglob("*")):
            rel = f.relative_to(voice_dir).as_posix()
            if f.is_file() and VOICE_FILES.match(rel):
                z.write(f, rel)
    return buf.getvalue()


def import_voice_pack(data: bytes, voices_root: Path, voice_id: str) -> Path:
    """Unpack into voices/<voice_id>/ (which must not exist). Only the known voice files are taken."""
    from .voices import write_json_atomic
    d = voices_root / voice_id
    if d.exists():
        raise FileExistsError(voice_id)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos = _safe_names(z, VOICE_MAX_BYTES)
        names = {i.filename for i in infos}
        if "meta.json" not in names or "ref.wav" not in names:
            raise ValueError("not a FireVoice voice pack (needs meta.json and ref.wav)")
        meta = json.loads(z.read("meta.json").decode("utf-8"))
        tmp = voices_root / f".import-{uuid.uuid4().hex[:8]}"
        tmp.mkdir(parents=True)
        try:
            for info in infos:
                if VOICE_FILES.match(info.filename) and info.filename != "meta.json":
                    (tmp / info.filename).parent.mkdir(parents=True, exist_ok=True)
                    (tmp / info.filename).write_bytes(z.read(info))
            meta["voice_id"] = voice_id
            meta.pop("dir", None)
            write_json_atomic(tmp / "meta.json", meta)
            tmp.rename(d)
        except Exception:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
    return d
