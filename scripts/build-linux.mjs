// Builds the Linux packages (AppImage for updates, .deb and .rpm) in Docker, from any computer that runs it, and
// copies them to a folder.
//
//   node scripts/build-linux.mjs <outdir> [--bundles appimage,deb,rpm]
//
// The image (docker/linux/Dockerfile) and the caches (Cargo, pnpm, the build folder) are kept between runs, so only
// the first build is long. The updater signing key is read from %USERPROFILE%\.firevoice-release\ like release.mjs does
// (FIREVOICE_RELEASE_KEYS overrides) and goes to the container as environment variables, never to disk.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { root } from "./version.mjs";

const IMAGE = "firevoice-linux-build:1";
const args = process.argv.slice(2);
const outDir = resolve(args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--bundles") ?? join(root, "release", "linux"));
const bundles = args.includes("--bundles") ? args[args.indexOf("--bundles") + 1] : "appimage,deb,rpm";
const KEYS = process.env.FIREVOICE_RELEASE_KEYS ?? join(homedir(), ".firevoice-release");

const fail = (m) => {
  console.error(`[build-linux] ${m}`);
  process.exit(1);
};
const docker = (a, opts = {}) => spawnSync("docker", a, { stdio: "inherit", ...opts });

if (docker(["info"], { stdio: "ignore" }).status !== 0) fail("Docker is not running. Start Docker Desktop and try again.");
mkdirSync(outDir, { recursive: true });

console.log("[build-linux] preparing the build image (the first time takes a few minutes)");
if (docker(["build", "--platform", "linux/amd64", "-t", IMAGE, join(root, "docker", "linux")]).status !== 0) fail("the build image could not be made.");

const env = [];
for (const [name, file] of [["TAURI_SIGNING_PRIVATE_KEY", "updater.key"], ["TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "updater.password"]]) {
  const p = join(KEYS, file);
  if (existsSync(p)) env.push("-e", `${name}=${readFileSync(p, "utf8").trim()}`);
  else console.warn(`[build-linux] ${p} is missing: the update file will not be signed`);
}

console.log(`[build-linux] building ${bundles} (output in ${outDir})`);
const r = docker([
  "run", "--rm", "--platform", "linux/amd64",
  "-v", `${root}:/src:ro`,
  "-v", `${outDir}:/out`,
  "-v", "firevoice-linux-cargo:/opt/cargo/registry",
  "-v", "firevoice-linux-target:/work/src-tauri/target",
  "-v", "firevoice-linux-pnpm:/root/.local/share/pnpm",
  "-v", "firevoice-linux-uv:/root/.cache/uv",
  "-e", `FIREVOICE_BUNDLES=${bundles}`,
  ...env,
  IMAGE,
]);
if (r.status !== 0) fail("the Linux build failed (see above).");
const made = readdirSync(outDir).filter((f) => /\.(AppImage|sig|deb|rpm)$/.test(f));
if (!made.some((f) => f.endsWith(".AppImage"))) fail("the build made no AppImage.");
console.log(`[build-linux] done: ${made.join(", ")}`);
