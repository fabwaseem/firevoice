# Downloads the big wheels of the backend runtime (torch, torchaudio) into a folder that `uv pip install --find-links`
# reads, with byte-exact progress, resume after an interruption, and a sha256 check. Run by src-tauri/src/backend.rs
# inside the runtime's own Python (standard library only), so it works before anything else is installed.
#
#   python fetch_wheels.py --index URL --dest DIR torch==2.11.0 torchaudio==2.11.0
#
# Progress goes to stdout as lines starting with "@@ " and a JSON object:
#   {"event": "plan", "items": [{"name", "file", "total"}]}        once, before downloading
#   {"event": "progress", "name", "done", "total"}                  a few times a second per file
#   {"event": "done", "name"}                                        a file is complete and checked
# Any failure exits non-zero with the reason on stderr; the caller then lets uv download the wheels itself.
import hashlib
import html
import json
import os
import platform
import re
import sys
import time
import urllib.parse
import urllib.request

UA = {"User-Agent": "FireVoice-desktop"}
MARKER = ".downloading"  # tells engine installs (backend/src/firevoice/installer.py) to wait for this download


def say(**kw):
    print("@@ " + json.dumps(kw), flush=True)


def plat_ok(tag: str) -> bool:
    m = platform.machine().lower()
    if sys.platform == "win32":
        return tag == "win_amd64" if m in ("amd64", "x86_64") else tag == "win_arm64"
    if sys.platform == "darwin":
        return tag.startswith("macosx") and (tag.endswith("arm64") or tag.endswith("universal2")) if m == "arm64" else tag.endswith("x86_64")
    return tag.startswith("manylinux") and tag.endswith("aarch64" if m in ("aarch64", "arm64") else "x86_64")


def find(index: str, name: str, version: str) -> tuple[str, str, str]:
    """(url, filename, sha256) of the wheel for this Python and platform."""
    page = f"{index.rstrip('/')}/{name}/"
    with urllib.request.urlopen(urllib.request.Request(page, headers=UA), timeout=60) as r:
        body = r.read().decode("utf-8", "replace")
    py = f"cp{sys.version_info.major}{sys.version_info.minor}"
    for href in re.findall(r'href="([^"]+)"', body):
        href = html.unescape(href)
        url, _, frag = href.partition("#")
        fname = urllib.parse.unquote(url.rsplit("/", 1)[-1])
        m = re.fullmatch(rf"{re.escape(name)}-{re.escape(version)}(\+[\w.]+)?-{py}-{py}-(.+)\.whl", fname)
        if not m or not any(plat_ok(t) for t in m.group(2).split(".")):
            continue
        sha = frag.split("=", 1)[1] if frag.startswith("sha256=") else ""
        return urllib.parse.urljoin(page, url), fname, sha
    raise SystemExit(f"no {name} {version} wheel for {py} on this computer at {page}")


def size(url: str) -> int:
    req = urllib.request.Request(url, headers=UA, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers.get("Content-Length") or 0)


def sha_of(path: str) -> "hashlib._Hash":
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h


def fetch(dest: str, name: str, url: str, fname: str, sha: str, total: int, touch) -> None:
    final = os.path.join(dest, fname)
    ok = final + ".ok"
    if os.path.exists(final) and os.path.exists(ok):
        say(event="done", name=name)
        return
    part = final + ".part"
    for attempt in range(6):
        try:
            have = os.path.getsize(part) if os.path.exists(part) else 0
            if total and have > total:
                os.remove(part)
                have = 0
            h = sha_of(part) if have else hashlib.sha256()
            if not total or have < total:
                headers = dict(UA)
                if have:
                    headers["Range"] = f"bytes={have}-"
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as r:
                    if have and r.status != 206:  # the server ignored the range: start over
                        have, h = 0, hashlib.sha256()
                    total = total or have + int(r.headers.get("Content-Length") or 0)
                    last = 0.0
                    with open(part, "ab" if have else "wb") as f:
                        while True:
                            chunk = r.read(1 << 20)
                            if not chunk:
                                break
                            f.write(chunk)
                            h.update(chunk)
                            have += len(chunk)
                            now = time.monotonic()
                            if now - last > 0.25:
                                last = now
                                say(event="progress", name=name, done=have, total=total)
                                touch()
            say(event="progress", name=name, done=have, total=total)
            if total and have != total:
                raise OSError(f"the download stopped at {have} of {total} bytes")
            if sha and h.hexdigest() != sha:
                os.remove(part)
                raise OSError(f"{fname} did not match its checksum; downloading it again")
            os.replace(part, final)
            with open(ok, "w") as f:
                f.write(sha or "unchecked")
            say(event="done", name=name)
            return
        except (OSError, ValueError) as e:  # network trouble: wait, then carry on from where it stopped
            print(f"{name}: {e}", file=sys.stderr, flush=True)
            if attempt == 5:
                raise SystemExit(f"could not download {fname}: {e}")
            time.sleep(min(30, 2 ** attempt))


def main() -> None:
    args = sys.argv[1:]
    index = args[args.index("--index") + 1]
    dest = args[args.index("--dest") + 1]
    specs = [a for i, a in enumerate(args) if "==" in a and args[i - 1] not in ("--index", "--dest")]
    os.makedirs(dest, exist_ok=True)
    marker = os.path.join(dest, MARKER)

    def touch():
        with open(marker, "w") as f:
            f.write(str(os.getpid()))

    touch()
    try:
        wanted = []
        for spec in specs:
            name, version = spec.split("==", 1)
            url, fname, sha = find(index, name, version)
            wanted.append((name, url, fname, sha, size(url)))
        # older versions left here are dead weight (they are several GB each)
        keep = {w[2] for w in wanted}
        for f in os.listdir(dest):
            base = f[: -len(".part")] if f.endswith(".part") else f[: -len(".ok")] if f.endswith(".ok") else f
            if base.endswith(".whl") and base not in keep:
                os.remove(os.path.join(dest, f))
        say(event="plan", items=[{"name": n, "file": f, "total": t} for n, _, f, _, t in wanted])
        for name, url, fname, sha, total in wanted:
            fetch(dest, name, url, fname, sha, total, touch)
    finally:
        try:
            os.remove(marker)
        except OSError:
            pass


if __name__ == "__main__":
    main()
