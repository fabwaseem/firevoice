"""Build the voice library pack the app downloads during setup (backend/src/firevoice/voicepack.py).

    backend/.venv/Scripts/python.exe scripts/build-voices-pack.py            build from the ids already listed in voicepack.json
    backend/.venv/Scripts/python.exe scripts/build-voices-pack.py --all      ship every voice in the source folder (and list them)
    options: --src DIR (default ~/.firevoice/voices, or FIREVOICE_VOICES_SRC)   --out DIR (default release/voices)

It writes release/voices/FireVoice-voices-<N>.zip and rewrites backend/src/firevoice/voicepack.json (version, URL, size,
SHA-256, the ids, the default voice). The ids are listed in that committed file on purpose: only voices listed there
ever ship, so a personal voice added to your own library later never ends up in a release by accident.

Publishing is a separate, deliberate step (it puts the file on the public releases repo); the script prints the command.
The zip is reproducible: the same voices give the same bytes and the same SHA-256.
"""
import argparse
import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INFO = ROOT / "backend" / "src" / "firevoice" / "voicepack.json"
RELEASES = "fabwaseem/firevoice-releases"
FILES = ("meta.json", "ref.wav", "ref.txt", "preview.mp3", "avatar.png")
STAMP = (2026, 1, 1, 0, 0, 0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.environ.get("FIREVOICE_VOICES_SRC") or str(Path.home() / ".firevoice" / "voices"))
    ap.add_argument("--out", default=str(ROOT / "release" / "voices"))
    ap.add_argument("--all", action="store_true", help="ship every voice in the source folder")
    a = ap.parse_args()
    src, out = Path(a.src), Path(a.out)
    old = json.loads(INFO.read_text(encoding="utf-8")) if INFO.exists() else {}
    if a.all:
        ids = sorted(d.name for d in src.iterdir() if (d / "meta.json").exists() and (d / "ref.wav").exists())
    else:
        ids = list(old.get("ids") or [])
    if not ids:
        print("no voices to ship: use --all the first time", file=sys.stderr)
        return 1
    missing = [i for i in ids if not (src / i / "meta.json").exists() or not (src / i / "ref.wav").exists()]
    if missing:
        print(f"these listed voices are not in {src}: {', '.join(missing)}", file=sys.stderr)
        return 1
    default = None
    if (src / "default.txt").exists():
        d = (src / "default.txt").read_text(encoding="utf-8").strip()
        default = d if d in ids else None
    default = default or old.get("default") or ids[0]

    def build(version: int) -> Path:
        out.mkdir(parents=True, exist_ok=True)
        zp = out / f"FireVoice-voices-{version}.zip"
        with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            def put(name: str, data: bytes) -> None:
                zi = zipfile.ZipInfo(name, STAMP)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.external_attr = 0o644 << 16
                z.writestr(zi, data)
            put("pack.json", json.dumps({"version": version, "ids": ids, "default": default}, indent=1).encode())
            for i in ids:
                d = src / i
                names = [f for f in FILES if (d / f).exists()]
                if (d / "refs").is_dir():
                    names += [f"refs/{p.name}" for p in sorted((d / "refs").iterdir()) if p.suffix in (".wav", ".txt")]
                for n in names:
                    put(f"voices/{i}/{n}", (d / n).read_bytes())
        return zp

    version = int(old.get("version") or 1)
    zp = build(version)
    sha = hashlib.sha256(zp.read_bytes()).hexdigest()
    if old.get("sha256") and old["sha256"] != sha and sorted(old.get("ids") or []) != sorted(ids) or (old.get("sha256") not in (None, sha) and version == old.get("version")):
        # the contents changed since the published pack: a new version, a new file, a new URL
        version += 1
        zp.unlink()
        zp = build(version)
        sha = hashlib.sha256(zp.read_bytes()).hexdigest()
    info = {"version": version, "url": f"https://github.com/{RELEASES}/releases/download/voices-{version}/{zp.name}", "bytes": zp.stat().st_size,
            "sha256": sha, "count": len(ids), "default": default, "ids": ids}
    INFO.write_text(json.dumps(info, indent=1) + "\n", encoding="utf-8")
    print(f"{zp}  {zp.stat().st_size / 1e6:.1f} MB  sha256 {sha[:16]}...  {len(ids)} voices, default {default}")
    print(f"voicepack.json updated (version {version}).")
    print("To publish it (puts the file on the public releases repo):")
    print(f'  gh release create voices-{version} "{zp}" --repo {RELEASES} --title "FireVoice voice library {version}" '
          f'--notes "The voice library FireVoice downloads during setup. Not meant to be downloaded by hand."')
    return 0


if __name__ == "__main__":
    sys.exit(main())
