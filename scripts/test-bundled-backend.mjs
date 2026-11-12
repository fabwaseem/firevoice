// Checks the wheel staged for the installer (src-tauri/resources/backend/), not the source: the compiled modules that
// users get are the ones under test.
//
//   node scripts/test-bundled-backend.mjs                          the quick check a release build runs (seconds):
//                                                                  compiled and no source, it imports, its server
//                                                                  starts and answers, and it resamples audio with
//                                                                  the ffmpeg the app ships
//   node scripts/test-bundled-backend.mjs --full [pytest args]     the whole test suite against it (run before a release,
//                                                                  on Windows and in Linux: see the README)
//
// It also checks the staged wheel is the protected one (no Python source in it). The tests run in backend/.venv
// (node scripts/dev-setup.mjs) with the unpacked wheel ahead of everything else on the import path.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staged = join(root, "src-tauri", "resources", "backend");
const win = process.platform === "win32";
const py = join(root, "backend", ".venv", win ? "Scripts\\python.exe" : "bin/python");

function fail(msg) {
  console.error(`[test-bundled-backend] ${msg}`);
  process.exit(1);
}

if (!existsSync(join(staged, "backend.json"))) fail("nothing is staged: node scripts/bundle-backend.mjs");
const recipe = JSON.parse(readFileSync(join(staged, "backend.json"), "utf8"));
if (recipe.protected !== true) fail(`the staged wheel ${recipe.wheel} is the plain source wheel: node scripts/bundle-backend.mjs`);
if (!existsSync(py)) fail("backend/.venv is missing: node scripts/dev-setup.mjs");

const site = join(root, "src-tauri", "target", "backend-protect", "site");
rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
let r = spawnSync(py, ["-m", "zipfile", "-e", join(staged, recipe.wheel), site], { stdio: "inherit" });
if (r.status !== 0) fail(`could not unpack ${recipe.wheel}`);

// what is in the file that ships: no source, and compiled modules for every Python the recipe needs
const all = readdirSync(site, { recursive: true }).map(String);
const source = all.filter((f) => /\.(py|pyc|pyx|c)$/i.test(f));
if (source.length) fail(`the staged wheel holds source files: ${source.slice(0, 5).join(", ")}`);
if (!all.some((f) => /\.(pyd|so)$/i.test(f))) fail("the staged wheel holds no compiled modules");

console.log(`[test-bundled-backend] testing ${recipe.wheel} (compiled, no source)`);
const env = { ...process.env, PYTHONPATH: site };
r = spawnSync(py, ["-c", "import firevoice, sys; print(firevoice.__file__); sys.exit(0 if firevoice.__file__.endswith(('.pyd', '.so')) else 1)"], { env, encoding: "utf8" });
if (r.status !== 0) fail(`the tests would not run the staged wheel (firevoice loads from ${r.stdout?.trim() || "nowhere"})`);

if (process.argv.includes("--full")) {
  const args = process.argv.slice(2).filter((a) => a !== "--full");
  r = spawnSync(py, ["-m", "pytest", "-q", "-p", "no:cacheprovider", ...args], { cwd: join(root, "backend"), env, stdio: "inherit" });
  if (r.status !== 0) fail("the backend tests failed against the staged wheel");
  console.log("[test-bundled-backend] the staged wheel passes the backend tests");
  process.exit(0);
}

// the quick check: the server starts in an empty data folder and answers /health, and audio resamples with the
// ffmpeg the app ships (imageio-ffmpeg), not one that happens to be on this machine
const home = join(root, "src-tauri", "target", "backend-protect", "home");
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
const check = String.raw`
import json, os, socket, subprocess, sys, time, urllib.request
import numpy as np
import imageio_ffmpeg
from firevoice import audio
os.environ["FIREVOICE_FFMPEG"] = imageio_ffmpeg.get_ffmpeg_exe()
t = np.arange(24000, dtype=np.float32) / 24000
y = audio.resample(np.sin(2 * np.pi * 440 * t).astype(np.float32), 24000, 16000)
assert abs(len(y) - 16000) <= 32 and float(np.abs(y).max()) > 0.5, "resampling with the shipped ffmpeg gave no audio"
print("resample ok with", os.path.basename(os.environ["FIREVOICE_FFMPEG"]))
s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, "-X", "utf8", "-c", "import sys; from firevoice.server import main; sys.exit(main())", "--port", str(port)])
try:
    for _ in range(240):
        if srv.poll() is not None:
            sys.exit(f"the server exited with code {srv.returncode} before answering")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                h = json.load(r)
            assert h.get("ok"), h
            print("server ok:", h.get("version"), "api", h.get("api_version"))
            break
        except OSError:
            time.sleep(0.5)
    else:
        sys.exit("the server did not answer /health within 2 minutes")
finally:
    srv.kill()
    srv.wait(timeout=10)
`;
r = spawnSync(py, ["-X", "utf8", "-c", check], { env: { ...env, FIREVOICE_HOME: home }, stdio: "inherit", timeout: 240_000 });
if (r.status !== 0) fail("the staged wheel failed its quick check");
console.log("[test-bundled-backend] the staged wheel passes its quick check (run --full for the whole test suite)");
