// Runs the backend's test suite against the wheel staged for the installer (src-tauri/resources/backend/), not the
// source: the compiled modules that users get are the ones under test. A release runs this after its build.
//
//   node scripts/test-bundled-backend.mjs [pytest arguments]
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
r = spawnSync(py, ["-m", "pytest", "-q", "-p", "no:cacheprovider", ...process.argv.slice(2)], { cwd: join(root, "backend"), env, stdio: "inherit" });
if (r.status !== 0) fail("the backend tests failed against the staged wheel");
console.log("[test-bundled-backend] the staged wheel passes the backend tests");
