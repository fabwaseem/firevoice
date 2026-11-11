// Copies the FireVoice backend into the desktop build (run before `tauri build`; see tauri.conf.json).
//
// The backend is its own Python project in backend/ (or FIREVOICE_BACKEND_SRC): this script builds its wheel and puts
// it, uv, and a pinned recipe into src-tauri/resources/backend/. On first run the app builds a private Python runtime
// from those (see src-tauri/src/backend.rs), so the installer stays small while the whole backend ships with the app.
//
// The wheel that ships holds no Python source. Every module is compiled to a native extension module (see
// scripts/protect-backend.py), once for each Python version that runs the package: the app's runtime and the engine
// venvs. If any of that fails the build fails: it never falls back to shipping source.
//
//   node scripts/bundle-backend.mjs            build the protected wheel and stage everything
//   node scripts/bundle-backend.mjs --plain    stage the plain source wheel (debugging only; a release refuses it)
//   node scripts/bundle-backend.mjs --check    only print what would be staged
//
// Needs a C compiler (on Windows: the Visual Studio Build Tools that Rust already uses).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RECIPE } from "./backend-recipe.mjs";

// The compiler toolchain is pinned so the same source always gives the same build.
const CYTHON = "3.3.1";
const SETUPTOOLS = "84.2.1";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(process.env.FIREVOICE_BACKEND_SRC ?? join(root, "backend"));
const out = join(root, "src-tauri", "resources", "backend");
const check = process.argv.includes("--check");
const plain = process.argv.includes("--plain") || process.env.FIREVOICE_PLAIN_BACKEND === "1";
const win = process.platform === "win32";

// The runtime the bundled backend is built with: the same recipe as the dev environment (scripts/backend-recipe.mjs).

function fail(msg) {
  console.error(`[bundle-backend] ${msg}`);
  process.exit(1);
}

if (!existsSync(join(src, "pyproject.toml"))) fail(`backend source not found at ${src} (set FIREVOICE_BACKEND_SRC)`);
const pyproject = readFileSync(join(src, "pyproject.toml"), "utf8");
const version = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? fail("no version in pyproject.toml");
if (!/^desktop\s*=/m.test(pyproject)) fail("the backend has no `desktop` extra (backend/pyproject.toml)");
const init = readFileSync(join(src, "src", "firevoice", "__init__.py"), "utf8");
const apiVersion = Number(init.match(/^API_VERSION\s*=\s*(\d+)/m)?.[1] ?? fail("no API_VERSION in firevoice/__init__.py"));

function which(cmd) {
  try {
    const r = execFileSync(win ? "where" : "which", [cmd], { encoding: "utf8" }).split(/\r?\n/).find(Boolean);
    return r?.trim();
  } catch {
    return null;
  }
}
const uv = process.env.FIREVOICE_UV ?? which("uv");
if (!uv) fail("uv not found on PATH (https://docs.astral.sh/uv/)");

// Every Python version that imports the package: the app's runtime, and each engine venv (installer.py), whose
// workers import it too. A compiled module only loads in the version it was built for.
const installer = readFileSync(join(src, "src", "firevoice", "installer.py"), "utf8");
const pythons = [...new Set([RECIPE.python, ...[...installer.matchAll(/\bpython(?:: str)?\s*=\s*"(\d+\.\d+)"/g)].map((m) => m[1])])].sort();

console.log(`[bundle-backend] backend ${version} (API ${apiVersion}) from ${src}`);
console.log(`[bundle-backend] uv ${uv}`);
console.log(`[bundle-backend] -> ${out}`);
console.log(`[bundle-backend] ${plain ? "PLAIN SOURCE wheel (not for release)" : `compiled for Python ${pythons.join(", ")}`}`);
if (check) process.exit(0);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, ".gitkeep"), "");

let wheel;
if (plain) {
  execFileSync(uv, ["build", "--wheel", "--out-dir", out, src], { stdio: "inherit" });
  wheel = readdirSync(out).find((f) => f.endsWith(".whl")) ?? fail("uv build produced no wheel");
} else {
  const work = join(root, "src-tauri", "target", "backend-protect");
  const stage = join(work, "stage");
  const script = join(root, "scripts", "protect-backend.py");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync(uv, ["build", "--wheel", "--out-dir", join(work, "plain"), src], { stdio: "inherit" });
  const built = readdirSync(join(work, "plain")).find((f) => f.endsWith(".whl")) ?? fail("uv build produced no wheel");
  const py = (v, args, opts = {}) =>
    execFileSync(uv, ["run", "--no-project", "--python", v, "--with", `cython==${CYTHON}`, "--with", `setuptools==${SETUPTOOLS}`, "python", script, ...args], {
      stdio: "inherit",
      ...opts,
    });
  py(RECIPE.python, ["unpack", join(work, "plain", built), stage]);
  for (const v of pythons) {
    console.log(`[bundle-backend] compiling for Python ${v} (about a minute)`);
    const log = join(work, `compile-${v}.log`);
    try {
      writeFileSync(log, py(v, ["compile", stage, join(work, "build")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }));
    } catch (e) {
      const text = [e.stdout, e.stderr].filter(Boolean).join("\n");
      writeFileSync(log, text);
      console.error(text.split("\n").slice(-25).join("\n"));
      fail(`compiling the backend for Python ${v} failed (full output: ${log})`);
    }
  }
  const outText = py(RECIPE.python, ["pack", stage, out, "--builds", String(pythons.length)], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  process.stdout.write(outText);
  wheel = outText.match(/^WHEEL=(.+)$/m)?.[1]?.trim() ?? fail("the protected wheel was not written");
  if (!existsSync(join(out, wheel))) fail(`${wheel} is missing from ${out}`);
}
// The whole runtime, resolved now and pinned: the app installs the small core first (enough to start the server) and the
// rest (torch and the voice libraries) in the background while the server runs. With every version fixed up front, the
// background install only adds packages and never replaces one the running server has loaded (Windows locks those).
{
  const lockDir = join(root, "src-tauri", "target", "backend-lock");
  mkdirSync(lockDir, { recursive: true });
  const wheelUrl = `file:///${join(out, wheel).replace(/\\/g, "/").replace(/^\//, "")}`;
  const req = join(lockDir, "requirements.in");
  const ovr = join(lockDir, "overrides.txt");
  writeFileSync(req, `firevoice[${RECIPE.extras.join(",")}] @ ${wheelUrl}\ntorch==${RECIPE.torch}\ntorchaudio==${RECIPE.torch}\n`);
  writeFileSync(ovr, `${RECIPE.overrides.join("\n")}\n`);
  const lock = join(lockDir, "constraints.txt");
  console.log("[bundle-backend] pinning the runtime's packages");
  execFileSync(uv, [
    "pip", "compile", req, "--override", ovr, "--extra-index-url", RECIPE.torch_index, "--index-strategy", "unsafe-best-match",
    "--python-version", RECIPE.python, "--no-header", "--no-annotate", "--quiet", "-o", lock,
    // every package must come ready-made for this system: users have no C compiler (docopt is pure Python, safe to build)
    "--only-binary", ":all:", "--no-binary", "docopt",
  ], { stdio: "inherit" });
  const pins = readFileSync(lock, "utf8").split(/\r?\n/).filter((l) => l.trim() && !/^firevoice\b/i.test(l.trim()));
  if (!pins.some((l) => l.startsWith(`torch==${RECIPE.torch}`))) fail("the pinned runtime has no torch");
  writeFileSync(join(out, "constraints.txt"), `${pins.join("\n")}\n`);
}
copyFileSync(uv, join(out, win ? "uv.exe" : "uv"));
writeFileSync(
  join(out, "backend.json"),
  JSON.stringify({ version, api_version: apiVersion, wheel, protected: !plain, ...RECIPE, core_extras: ["server"], constraints: "constraints.txt" }, null, 1),
);
console.log(`[bundle-backend] staged ${wheel}, uv and backend.json`);
