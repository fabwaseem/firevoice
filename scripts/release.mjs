// Build, sign and publish a FireVoice release from this computer (no CI).
//
//   node scripts/release.mjs <patch|minor|major|X.Y.Z> --notes-file notes.md   (or --notes "One line")
//
// What it does, in order (every step can be run again: a failed release resumes with the same X.Y.Z):
//   1. checks: on main, nothing uncommitted, gh signed in, both repos reachable, the signing key present, the tag free
//   2. tests: the app's type check and the backend's test suite (--skip-tests to leave them out)
//   3. sets the version in all six files, adds the notes to CHANGELOG.md, commits "Release vX.Y.Z" and tags it
//   4. builds the signed installers (NSIS for updates, MSI for manual installs) into release/vX.Y.Z/ with latest.json,
//      and the Linux packages (AppImage for updates, .deb, .rpm) in Docker (scripts/build-linux.mjs),
//      the release notes and SHA256SUMS.txt. The backend ships compiled, with no Python source (bundle-backend.mjs):
//      the build is refused if the staged wheel is not that one, and the backend tests are run again against it
//   5. pushes main and the tag to the private code repo, then publishes the files to the public releases repo
//   6. confirms the update feed now announces vX.Y.Z
//
// Options:
//   --dry-run          build and stage everything in release/vX.Y.Z/ but commit, tag, push and publish nothing
//                      (the version files are put back afterwards)
//   --skip-linux       leave the Linux packages out (a release made on a computer without Docker)
//   --skip-tests       leave out step 2 and the tests of the compiled backend in step 4
//   --rebuild          build again even if release/vX.Y.Z/ already holds installers
//   --feed-base URL    download URL base written into latest.json (default: the public release's own download URL;
//                      only for testing an update against a local server)
//
// Secrets stay outside the repo, in %USERPROFILE%\.firevoice-release\ (override with FIREVOICE_RELEASE_KEYS):
//   updater.key, updater.key.pub, updater.password. Losing them means installed copies can no longer update.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compare, currentVersion, isPlain, nextVersion, root, setVersion, VERSION_FILES } from "./version.mjs";

const CODE_REPO = "fabwaseem/firevoice";
const RELEASES_REPO = "fabwaseem/firevoice-releases";
const FEED = `https://github.com/${RELEASES_REPO}/releases/latest/download/latest.json`;
const KEYS = process.env.FIREVOICE_RELEASE_KEYS ?? join(homedir(), ".firevoice-release");
const win = process.platform === "win32";

// ------------------------------------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const how = argv.find((a, i) => !a.startsWith("--") && !["--notes", "--notes-file", "--feed-base"].includes(argv[i - 1]));
const dry = flag("--dry-run");

const step = (m) => console.log(`\n\x1b[1m[release] ${m}\x1b[0m`);
const info = (m) => console.log(`[release] ${m}`);
function fail(m) {
  console.error(`\n\x1b[31m[release] ${m}\x1b[0m`);
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: win && cmd === "pnpm", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}
const out = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", ...opts }).trim();
const tryOut = (cmd, args) => {
  try {
    return out(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

if (!how) fail("which version? node scripts/release.mjs <patch|minor|major|X.Y.Z> --notes-file notes.md");

// ------------------------------------------------------------------------------------------------ 1. checks
step("1/6 checks");
const current = currentVersion();
// resuming: the release commit is already made (the version files say X.Y.Z and HEAD carries its tag), so running
// the same command again (even "patch") carries on with that release
const headTags = (tryOut("git", ["tag", "--points-at", "HEAD"]) ?? "").split(/\s+/);
const resuming = !dry && headTags.includes(`v${current}`) && (how === current || ["patch", "minor", "major"].includes(how));
const version = resuming ? current : nextVersion(current, how);
const tag = `v${version}`;
if (!isPlain(version)) fail(`${version} is not MAJOR.MINOR.PATCH`);
if (!resuming && compare(version, current) <= 0) fail(`${version} is not newer than the current ${current}`);
info(`${resuming ? "resuming" : "releasing"} ${tag} (current ${current})${dry ? ", dry run" : ""}`);

if (!dry) {
  if (out("git", ["branch", "--show-current"]) !== "main") fail("release from the main branch");
  if (out("git", ["status", "--porcelain"])) fail("commit or stash your changes first (git status)");
  if (tryOut("gh", ["auth", "status"]) === null) fail("gh is not signed in (gh auth login)");
  const remote = tryOut("git", ["remote", "get-url", "origin"]) ?? "";
  if (!remote.includes(CODE_REPO)) fail(`origin should be ${CODE_REPO} (git remote -v)`);
  if (tryOut("gh", ["repo", "view", RELEASES_REPO, "--json", "name"]) === null) fail(`can't see ${RELEASES_REPO}`);
  if (!resuming && tryOut("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`])) fail(`tag ${tag} already exists`);
}
for (const f of ["updater.key", "updater.password"]) if (!existsSync(join(KEYS, f))) fail(`missing ${join(KEYS, f)}`);
const pub = readFileSync(join(KEYS, "updater.key.pub"), "utf8").trim();
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
if (conf.plugins?.updater?.pubkey !== pub) fail("the public key in tauri.conf.json is not the one next to updater.key");
if (!conf.plugins.updater.endpoints?.includes(FEED)) fail(`tauri.conf.json should list ${FEED} as the update endpoint`);

let notes = opt("--notes") ?? (opt("--notes-file") ? readFileSync(opt("--notes-file"), "utf8") : null);
const dir = join(root, "release", tag);
if (!notes && existsSync(join(dir, "notes.md"))) notes = readFileSync(join(dir, "notes.md"), "utf8");
if (!notes?.trim()) fail("release notes are required: --notes-file notes.md or --notes \"...\"");
notes = notes.trim();

// ------------------------------------------------------------------------------------------------ 2. tests
step("2/6 tests");
if (flag("--skip-tests") || resuming) info("skipped");
else {
  run("pnpm", ["typecheck"]);
  const py = join(root, "backend", ".venv", win ? "Scripts\\python.exe" : "bin/python");
  if (!existsSync(py)) fail("backend/.venv is missing: node scripts/dev-setup.mjs");
  run(py, ["-m", "pytest", "-q"], { cwd: join(root, "backend") });
}

// ------------------------------------------------------------------------------------------------ 3. version, changelog, commit, tag
step("3/6 version");
// a dry run puts back exactly what it changed (the files as they were, uncommitted edits included)
const saved = dry ? Object.fromEntries(VERSION_FILES.map((f) => [f, readFileSync(join(root, f), "utf8")])) : {};
const restore = () => {
  for (const [f, text] of Object.entries(saved)) writeFileSync(join(root, f), text);
};
if (resuming) info(`already at ${tag}`);
else {
  setVersion(version);
}
if (!resuming && !dry) {
  const date = new Date().toISOString().slice(0, 10);
  const cl = join(root, "CHANGELOG.md");
  const old = existsSync(cl) ? readFileSync(cl, "utf8") : "# Changelog\n";
  const [head, ...rest] = old.split(/\n(?=## )/);
  writeFileSync(cl, `${head.trimEnd()}\n\n## ${version} (${date})\n\n${notes}\n${rest.length ? `\n${rest.join("\n")}` : ""}`);
  run("git", ["add", ...VERSION_FILES, "CHANGELOG.md"]);
  run("git", ["commit", "-m", `Release ${tag}`]);
  run("git", ["tag", "-a", tag, "-m", `FireVoice ${version}`]);
  info(`version ${version}, committed and tagged ${tag}`);
} else if (dry) info(`version ${version} (working tree only, put back after the build)`);

// ------------------------------------------------------------------------------------------------ 4. build
step("4/6 build");
const nsisName = `FireVoice_${version}_x64-setup.exe`;
const msiName = `FireVoice_${version}_x64_en-US.msi`;
mkdirSync(dir, { recursive: true });
// a real release only reuses installers a real run built; a dry run's come from uncommitted files, so never ship them
const DRY_MARK = join(dir, ".dry-run");
const have = [nsisName, `${nsisName}.sig`, msiName].every((f) => existsSync(join(dir, f))) && (dry || !existsSync(DRY_MARK));
if (have && !flag("--rebuild")) info(`installers already in release/${tag}/ (--rebuild to build again)`);
else {
  const env = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(join(KEYS, "updater.key"), "utf8").trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: readFileSync(join(KEYS, "updater.password"), "utf8").trim(),
    // the app binary names source files in its error messages: keep this computer's folders (and user name) out of them
    CARGO_ENCODED_RUSTFLAGS: [`--remap-path-prefix=${root}=firevoice`, `--remap-path-prefix=${homedir()}=~`].join("\x1f"),
  };
  delete env.FIREVOICE_PLAIN_BACKEND; // a release never ships the backend as source
  const again = dry ? "the build failed." : `the build failed. Fix it (commit the fix), then run the same command again to resume ${tag}.`;
  const r = spawnSync("pnpm", ["tauri", "build"], { cwd: root, stdio: "inherit", shell: win, env });
  if (r.status !== 0) {
    restore();
    fail(again);
  }
  // what went into the installers: the compiled backend, and it passes the backend's tests
  const staged = JSON.parse(readFileSync(join(root, "src-tauri", "resources", "backend", "backend.json"), "utf8"));
  if (staged.protected !== true || /-none-any\.whl$/.test(staged.wheel)) {
    restore();
    fail(`the build bundled the backend as source (${staged.wheel}). Nothing was published.`);
  }
  if (readdirSync(join(root, "dist"), { recursive: true }).some((f) => String(f).endsWith(".map"))) {
    restore();
    fail("the UI build wrote source maps (dist/**/*.map). Nothing was published.");
  }
  if (flag("--skip-tests")) info("tests of the compiled backend skipped");
  else if (spawnSync("node", [join(root, "scripts", "test-bundled-backend.mjs")], { cwd: root, stdio: "inherit" }).status !== 0) {
    restore();
    fail(again);
  }
  if (dry) writeFileSync(DRY_MARK, "built by --dry-run; a real release builds again\n");
  else if (existsSync(DRY_MARK)) rmSync(DRY_MARK);
  const bundle = join(root, "src-tauri", "target", "release", "bundle");
  for (const [sub, f] of [["nsis", nsisName], ["nsis", `${nsisName}.sig`], ["msi", msiName], ["msi", `${msiName}.sig`]]) {
    const src = join(bundle, sub, f);
    if (existsSync(src)) copyFileSync(src, join(dir, f));
    else if (!f.endsWith(".msi.sig")) fail(`the build made no ${sub}/${f}`);
  }
}

// ---- Linux: the same version, built in Docker (the updater reads the AppImage; the .deb and .rpm are for manual installs)
const LINUX_FILE = /.(AppImage|AppImage.sig|deb|rpm)$/;
// only this version's files: a cached build folder can still hold an earlier version's packages
const linuxFiles = () => readdirSync(dir).filter((f) => LINUX_FILE.test(f) && f.includes(version));
if (flag("--skip-linux")) info("Linux packages skipped");
else if (linuxFiles().some((f) => f.endsWith(".AppImage")) && !flag("--rebuild") && (dry || !existsSync(DRY_MARK))) info("Linux packages already in this folder");
else {
  const tmp = join(dir, "linux-build");
  mkdirSync(tmp, { recursive: true });
  const r = spawnSync("node", [join(root, "scripts", "build-linux.mjs"), tmp], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    restore();
    fail("the Linux build failed (use --skip-linux to release without it).");
  }
  for (const f of readdirSync(tmp)) if (LINUX_FILE.test(f) && f.includes(version)) copyFileSync(join(tmp, f), join(dir, f));
  rmSync(tmp, { recursive: true, force: true });
}
restore();

const base = (opt("--feed-base") ?? `https://github.com/${RELEASES_REPO}/releases/download/${tag}`).replace(/\/$/, "");
const signature = readFileSync(join(dir, `${nsisName}.sig`), "utf8").trim();
const target = { signature, url: `${base}/${nsisName}` };
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: { "windows-x86_64": target, "windows-x86_64-nsis": target },
};
const appImage = linuxFiles().find((f) => f.endsWith(".AppImage"));
if (appImage && existsSync(join(dir, `${appImage}.sig`))) {
  const lin = { signature: readFileSync(join(dir, `${appImage}.sig`), "utf8").trim(), url: `${base}/${appImage}` };
  latest.platforms["linux-x86_64"] = lin;
  latest.platforms["linux-x86_64-appimage"] = lin;
}
writeFileSync(join(dir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
writeFileSync(join(dir, "notes.md"), `${notes}\n`);
const assets = [nsisName, `${nsisName}.sig`, msiName, ...linuxFiles(), "latest.json"].filter((f) => existsSync(join(dir, f)));
const sums = assets.filter((f) => !f.endsWith(".sig") && f !== "latest.json").map((f) => `${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}  ${f}`);
writeFileSync(join(dir, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
assets.push("SHA256SUMS.txt");
info(`staged in release/${tag}/: ${assets.join(", ")}`);

if (dry) {
  info("dry run: nothing committed, pushed or published");
  process.exit(0);
}

// ------------------------------------------------------------------------------------------------ 5. push and publish
step("5/6 publish");
run("git", ["push", "origin", "main", "--follow-tags"]);
const exists = tryOut("gh", ["release", "view", tag, "--repo", RELEASES_REPO, "--json", "tagName"]) !== null;
const files = assets.map((f) => join(dir, f));
if (exists) run("gh", ["release", "upload", tag, ...files, "--repo", RELEASES_REPO, "--clobber"]);
else
  run("gh", ["release", "create", tag, ...files, "--repo", RELEASES_REPO, "--title", `FireVoice ${version}`, "--notes-file", join(dir, "notes.md"), "--latest"]);

// ------------------------------------------------------------------------------------------------ 6. verify
step("6/6 verify");
let seen = null;
for (let i = 0; i < 6 && seen !== version; i++) {
  if (i) await new Promise((r) => setTimeout(r, 5000));
  try {
    const r = await fetch(FEED, { redirect: "follow", cache: "no-store" });
    seen = r.ok ? (await r.json()).version : null;
  } catch {
    seen = null;
  }
}
if (seen !== version) fail(`the update feed says ${seen ?? "nothing"}, not ${version}. Check https://github.com/${RELEASES_REPO}/releases`);
info(`done: FireVoice ${version} is live. Installed copies update the next time they start online.`);
