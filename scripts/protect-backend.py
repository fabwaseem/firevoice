"""Turns the backend wheel into one that ships no Python source (called by scripts/bundle-backend.mjs).

Every module of the package is compiled to a native extension module (Cython, then the C compiler), once per Python
version that runs it: the app's own runtime and the engine venvs, whose workers import the package too. The files for
all versions sit side by side (worker.cp311-win_amd64.pyd, worker.cp312-win_amd64.pyd); each Python loads its own.
The wheel that comes out holds those, the package's data files, and not one .py.

    protect-backend.py unpack  <wheel> <stage>            unpack the plain wheel
    protect-backend.py compile <stage> <build>            compile every module for the Python running this script
                                                          (needs cython and setuptools; run once per version)
    protect-backend.py pack    <stage> <out> --builds N   drop the sources, check nothing readable is left, write the wheel

What a compiled module still shows: names of modules, functions and classes, and text constants. Function bodies
are machine code. Docstrings are left out, except in the modules named in KEEP_DOCSTRINGS.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import os
import shutil
import sys
import sysconfig
import zipfile
from pathlib import Path

PACKAGE = "firevoice"
# The route docstrings in the server are the public API reference (shown at /docs), so they stay.
KEEP_DOCSTRINGS = {"firevoice.server"}
# Nothing with these endings may be in the wheel.
FORBIDDEN = {".py", ".pyc", ".pyo", ".pyx", ".pxd", ".c", ".h", ".map", ".ts", ".tsx"}


def fail(msg: str) -> "None":
    print(f"[protect-backend] {msg}", file=sys.stderr)
    raise SystemExit(1)


def sources(stage: Path) -> list[Path]:
    return sorted(f for f in (stage / PACKAGE).rglob("*.py") if "__pycache__" not in f.parts)


def dotted(stage: Path, f: Path) -> str:
    """firevoice/core/pool.py -> firevoice.core.pool; a package's __init__.py keeps its name (firevoice.core.__init__)."""
    return ".".join(f.relative_to(stage).with_suffix("").parts)


def unpack(wheel: Path, stage: Path) -> None:
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    with zipfile.ZipFile(wheel) as z:
        z.extractall(stage)
    print(f"[protect-backend] unpacked {wheel.name}: {len(sources(stage))} modules")


def compile_(stage: Path, build: Path) -> None:
    from Cython.Build import cythonize
    from setuptools import Extension
    from setuptools.command.build_ext import build_ext
    from setuptools.dist import Distribution
    from Cython.Compiler import Options

    class BuildExt(build_ext):
        def get_export_symbols(self, ext):
            # a package's __init__ exports PyInit_<package>, not PyInit___init__ (Cython already marks it exported)
            return []

    tag = sysconfig.get_config_var("EXT_SUFFIX")
    # Work on a copy with short relative paths (the C compiler's object paths repeat the source path), and keep the
    # generated C out of the folder that becomes the wheel.
    work = build / tag.strip(".").split(".")[0]
    shutil.rmtree(work, ignore_errors=True)
    for f in sources(stage):
        (work / f.relative_to(stage)).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, work / f.relative_to(stage))
    os.chdir(work)
    Options.docstrings = False
    exts = []
    for keep in (False, True):          # docstrings are a setting of the whole Cython run, so: two runs
        batch = [f for f in sources(work) if (dotted(work, f) in KEEP_DOCSTRINGS) == keep]
        if not batch:
            continue
        Options.docstrings = keep
        exts += cythonize(
            [Extension(dotted(work, f), [f.relative_to(work).as_posix()]) for f in batch],
            nthreads=0,
            force=True,
            quiet=True,
            compiler_directives={
                "language_level": "3",
                # the code stays plain Python in behaviour: annotations are not turned into C types or checks
                "annotation_typing": False,
                "binding": True,
                "embedsignature": False,
                "emit_code_comments": False,
            },
        )
    dist = Distribution({"name": PACKAGE, "ext_modules": exts})
    cmd = BuildExt(dist)
    cmd.build_lib = str(stage)
    cmd.build_temp = "obj"
    cmd.parallel = os.cpu_count() or 4
    cmd.ensure_finalized()
    cmd.run()
    missing = [f for f in sources(stage) if not f.with_name(f.stem + tag).exists()]
    if missing:
        fail(f"not compiled for {tag}: {', '.join(m.name for m in missing)}")
    print(f"[protect-backend] compiled {len(exts)} modules for {tag}")


def pack(stage: Path, out: Path, builds: int) -> None:
    info = next(stage.glob("*.dist-info"), None) or fail("no .dist-info in the unpacked wheel")
    for f in sources(stage):
        made = [p for p in f.parent.iterdir() if p.name.startswith(f.stem + ".") and p.suffix in (".pyd", ".so")]
        if len(made) != builds:
            fail(f"{f.relative_to(stage)} has {len(made)} compiled files, expected {builds}")
        f.unlink()
    for d in [d for d in stage.rglob("__pycache__")]:
        shutil.rmtree(d, ignore_errors=True)
    files = sorted(f for f in stage.rglob("*") if f.is_file())
    left = [f.relative_to(stage).as_posix() for f in files if f.suffix.lower() in FORBIDDEN]
    if left:
        fail(f"source files would ship: {', '.join(left)}")

    plat = sysconfig.get_platform().replace("-", "_").replace(".", "_")
    wheel_tag = f"py3-none-{plat}"
    (info / "WHEEL").write_text(f"Wheel-Version: 1.0\nGenerator: firevoice-protect\nRoot-Is-Purelib: false\nTag: {wheel_tag}\n", encoding="utf-8")
    record = info / "RECORD"
    record.unlink(missing_ok=True)
    lines = []
    files = sorted(f for f in stage.rglob("*") if f.is_file())
    for f in files:
        data = f.read_bytes()
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        lines.append(f"{f.relative_to(stage).as_posix()},sha256={digest},{len(data)}")
    lines.append(f"{record.relative_to(stage).as_posix()},,")
    record.write_text("\n".join(lines) + "\n", encoding="utf-8")

    name = f"{info.name.removesuffix('.dist-info')}-{wheel_tag}.whl"
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out / name, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in [*files, record]:
            z.write(f, f.relative_to(stage).as_posix())
    with zipfile.ZipFile(out / name) as z:     # the last word: what is really in the file that ships
        left = [n for n in z.namelist() if Path(n).suffix.lower() in FORBIDDEN]
        compiled = [n for n in z.namelist() if n.endswith((".pyd", ".so"))]
    if left or not compiled:
        (out / name).unlink()
        fail(f"the wheel is not clean: {left or 'no compiled modules'}")
    print(f"[protect-backend] {name}: {len(compiled)} compiled files, no source")
    print(f"WHEEL={name}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("unpack")
    p.add_argument("wheel", type=Path)
    p.add_argument("stage", type=Path)
    p = sub.add_parser("compile")
    p.add_argument("stage", type=Path)
    p.add_argument("build", type=Path)
    p = sub.add_parser("pack")
    p.add_argument("stage", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--builds", type=int, required=True)
    a = ap.parse_args()
    if a.cmd == "unpack":
        unpack(a.wheel.resolve(), a.stage.resolve())
    elif a.cmd == "compile":
        compile_(a.stage.resolve(), a.build.resolve())
    else:
        pack(a.stage.resolve(), a.out.resolve(), a.builds)


if __name__ == "__main__":
    main()
