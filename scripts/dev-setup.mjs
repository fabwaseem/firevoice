// Dev setup: build backend/.venv the way the installed app builds its runtime.
//
// The backend runs in development exactly as it does for users: the same Python, CUDA torch and `desktop` extra
// (scripts/backend-recipe.mjs), with this repo's backend/ installed in editable mode (plus the test tools), and the
// same data folder. Engines, model weights, voices and history live in the FireVoice data folder (~/.firevoice, or
// FIREVOICE_HOME) for dev and installed builds alike, so neither downloads what the other already has.
//
//   node scripts/dev-setup.mjs           create or update backend/.venv (safe to run again; uv's cache makes it quick)
//   node scripts/dev-setup.mjs --check   only report where things are
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { DEV_EXTRAS, RECIPE } from "./backend-recipe.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backend = join(root, "backend");
const venv = join(backend, ".venv");
const win = process.platform === "win32";
const py = join(venv, win ? "Scripts/python.exe" : "bin/python");
const check = process.argv.includes("--check");

const log = (m) => console.log(`[dev-setup] ${m}`);
const fail = (m) => {
  console.error(`[dev-setup] ${m}`);
  process.exit(1);
};

// a backend/.envs folder would win over the data folder (the backend prefers a checkout's .envs) and split dev from
// the installed app: refuse it
if (existsSync(join(backend, ".envs"))) fail(`backend/.envs exists. Move its engines into the data folder's engines/ folder, then remove it.`);

const where = () => {
  try {
    return execFileSync(py, ["-c", "import firevoice, os; from firevoice import paths; print(os.path.dirname(firevoice.__file__)); print(paths.engines_dir_info()); print(paths.weights_dir_info())"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

if (check) {
  log(existsSync(py) ? `python ${py}\n${where() ?? "(firevoice not importable)"}` : "backend/.venv does not exist yet");
  process.exit(0);
}

let uv;
try {
  uv = execFileSync(win ? "where" : "which", ["uv"], { encoding: "utf8" }).split(/\r?\n/).find(Boolean)?.trim();
} catch {
  fail("uv not found on PATH (https://docs.astral.sh/uv/)");
}
const run = (args) => execFileSync(uv, args, { stdio: "inherit", cwd: root });
// FIREVOICE_TORCH_INDEX swaps the torch index for this environment only (CI tests use the small CPU build)
const torchIndex = process.env.FIREVOICE_TORCH_INDEX || RECIPE.torch_index;

log(`building ${venv} (Python ${RECIPE.python}, torch ${RECIPE.torch}, extras ${[...RECIPE.extras, ...DEV_EXTRAS].join(", ")})`);
run(["venv", "--allow-existing", "--python", RECIPE.python, venv]);
run(["pip", "install", "--python", py, `torch==${RECIPE.torch}`, `torchaudio==${RECIPE.torch}`, "--index-url", torchIndex]);
const overrides = join(tmpdir(), "firevoice-dev-overrides.txt");
writeFileSync(overrides, `${RECIPE.overrides.join("\n")}\n`);
run([
  "pip", "install", "--python", py,
  "-e", `${backend}[${[...RECIPE.extras, ...DEV_EXTRAS].join(",")}]`,
  "--override", overrides,
  "--extra-index-url", torchIndex,
]);

const w = where();
if (!w) fail("firevoice does not import in the new environment");
const [pkg] = w.split(/\r?\n/);
if (resolve(pkg) !== resolve(join(backend, "src", "firevoice"))) fail(`the environment imports firevoice from ${pkg}, not backend/`);
log(`ready:\n${w}`);
