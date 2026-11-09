// Copies the FireVoice backend into the desktop build (run before `tauri build`; see tauri.conf.json).
//
// The backend stays its own project (../firevoice, or FIREVOICE_BACKEND_SRC): this script builds its wheel and puts
// it, uv, and a pinned recipe into src-tauri/resources/backend/. On first run the app builds a private Python runtime
// from those (see src-tauri/src/backend.rs), so the installer stays small while the whole backend ships with the app.
//
//   node scripts/bundle-backend.mjs            build the wheel from the backend source and stage everything
//   node scripts/bundle-backend.mjs --check    only print what would be staged
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(process.env.FIREVOICE_BACKEND_SRC ?? join(root, "..", "firevoice"));
const out = join(root, "src-tauri", "resources", "backend");
const check = process.argv.includes("--check");
const win = process.platform === "win32";

// The runtime the bundled backend is built with. Keep in step with the backend's tested versions (its .venv).
const RECIPE = {
  python: "3.12",
  extras: ["desktop"],
  torch: "2.11.0",
  torch_index: "https://download.pytorch.org/whl/cu128",
  // chatterbox-tts pins torch 2.6, which has no RTX 50-series kernels; the backend is tested on these instead
  overrides: ["torch==2.11.0", "torchaudio==2.11.0"],
};

function fail(msg) {
  console.error(`[bundle-backend] ${msg}`);
  process.exit(1);
}

if (!existsSync(join(src, "pyproject.toml"))) fail(`backend source not found at ${src} (set FIREVOICE_BACKEND_SRC)`);
const pyproject = readFileSync(join(src, "pyproject.toml"), "utf8");
const version = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? fail("no version in pyproject.toml");
if (!/^desktop\s*=/m.test(pyproject)) fail("the backend has no `desktop` extra; update ../firevoice");
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

console.log(`[bundle-backend] backend ${version} (API ${apiVersion}) from ${src}`);
console.log(`[bundle-backend] uv ${uv}`);
console.log(`[bundle-backend] -> ${out}`);
if (check) process.exit(0);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, ".gitkeep"), "");
execFileSync(uv, ["build", "--wheel", "--out-dir", out, src], { stdio: "inherit" });
const wheel = readdirSync(out).find((f) => f.endsWith(".whl")) ?? fail("uv build produced no wheel");
copyFileSync(uv, join(out, win ? "uv.exe" : "uv"));
writeFileSync(join(out, "backend.json"), JSON.stringify({ version, api_version: apiVersion, wheel, ...RECIPE }, null, 1));
console.log(`[bundle-backend] staged ${wheel}, uv and backend.json`);
