// The steps of a FireVoice release, run by .github/workflows/release.yml (GitHub Actions, started by hand).
//
//   node scripts/ci-release.mjs plan <patch|minor|major|X.Y.Z> [--dry-run]
//        works out the version, checks the tag is free, the notes exist and the updater settings are right.
//        Writes version, tag and sha to $GITHUB_OUTPUT.
//   node scripts/ci-release.mjs build <X.Y.Z> [--skip-tests]
//        on each OS: sets the version, builds the signed installers, checks no source ships, tests the compiled
//        backend, and copies the installers into release-out/<platform>/ with a platforms.json for the update feed.
//   node scripts/ci-release.mjs publish <X.Y.Z> [--dry-run]
//        gathers release-out/*/, writes latest.json and SHA256SUMS.txt, then (not in a dry run) commits
//        "Release vX.Y.Z" with the CHANGELOG entry, tags it, pushes main and the tag here, publishes every file as a
//        release of the public releases repo, and confirms the update feed announces the new version.
//        Safe to run again: a tag already pushed is kept, and files already on the release are replaced.
//
// Release notes: the workflow's "notes" input (one line), or else release-notes.md at the repo root (removed by the
// release commit, its text moves into CHANGELOG.md).
//
// Environment: TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD (build), GH_TOKEN with write access
// to the releases repo (publish), RELEASE_NOTES (the workflow input, may be empty).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compare, currentVersion, isPlain, nextVersion, root, setVersion, VERSION_FILES } from "./version.mjs";

const RELEASES_REPO = "fabwaseem/firevoice-releases";
const FEED = `https://github.com/${RELEASES_REPO}/releases/latest/download/latest.json`;
const NOTES_FILE = "release-notes.md";
const OUT = join(root, "release-out");
const win = process.platform === "win32";

const [cmd, arg] = process.argv.slice(2);
const flag = (n) => process.argv.includes(n);
const dry = flag("--dry-run");

const info = (m) => console.log(`[release] ${m}`);
function fail(m) {
  console.error(`\n[release] ERROR: ${m}`);
  process.exit(1);
}
function run(c, args, opts = {}) {
  const r = spawnSync(c, args, { cwd: root, stdio: "inherit", shell: win && c === "pnpm", ...opts });
  if (r.status !== 0) fail(`${c} ${args.join(" ")} failed (exit ${r.status})`);
}
const out = (c, args) => execFileSync(c, args, { cwd: root, encoding: "utf8" }).trim();
const output = (k, v) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  info(`${k}=${v}`);
};
const remoteTag = (tag) => out("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]) !== "";

function notes() {
  const input = process.env.RELEASE_NOTES?.trim();
  if (input) return input;
  const f = join(root, NOTES_FILE);
  const text = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
  if (!text) fail(`release notes are required: fill the "notes" input, or commit ${NOTES_FILE} to main first`);
  return text;
}

function plainVersion(v) {
  if (!v || !isPlain(v)) fail(`"${v}" is not MAJOR.MINOR.PATCH`);
  return v;
}

// ------------------------------------------------------------------------------------------------ plan
function plan() {
  const current = currentVersion();
  let version;
  try {
    version = nextVersion(current, arg ?? "");
  } catch (e) {
    fail(e.message);
  }
  plainVersion(version);
  if (compare(version, current) <= 0) fail(`${version} is not newer than the current ${current}`);
  const tag = `v${version}`;
  if (!dry && remoteTag(tag)) fail(`tag ${tag} already exists`);

  const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  if (!conf.plugins?.updater?.pubkey) fail("tauri.conf.json has no updater public key");
  if (!conf.plugins.updater.endpoints?.includes(FEED)) fail(`tauri.conf.json should list ${FEED} as the update endpoint`);
  notes();

  info(`${dry ? "dry run of" : "releasing"} ${tag} (current ${current})`);
  output("version", version);
  output("tag", tag);
  output("sha", out("git", ["rev-parse", "HEAD"]));
}

// ------------------------------------------------------------------------------------------------ build
const PLATFORM = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform];
const BUNDLES = { windows: "nsis,msi", macos: "app,dmg", linux: "appimage,deb,rpm" };

/** The one file in dir ending in ext (and not .sig). */
function one(dir, ext) {
  const found = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)) : [];
  if (found.length !== 1) fail(`expected one *${ext} in ${dir}, found ${found.length ? found.join(", ") : "none"}`);
  return join(dir, found[0]);
}

function build() {
  const version = plainVersion(arg);
  if (!PLATFORM) fail(`no release build for ${process.platform}`);
  for (const k of ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"]) if (!process.env[k]) fail(`${k} is not set (repository secret)`);
  setVersion(version);
  info(`building FireVoice ${version} for ${PLATFORM} (${BUNDLES[PLATFORM]})`);

  const env = {
    ...process.env,
    // the app binary names source files in its error messages: keep the runner's folders out of them
    CARGO_ENCODED_RUSTFLAGS: [`--remap-path-prefix=${root}=firevoice`, `--remap-path-prefix=${homedir()}=~`].join("\x1f"),
  };
  delete env.FIREVOICE_PLAIN_BACKEND; // a release never ships the backend as source
  const bundle = join(root, "src-tauri", "target", "release", "bundle");
  rmSync(bundle, { recursive: true, force: true }); // no installers left from an older build (the Rust cache)
  run("pnpm", ["tauri", "build", "--bundles", BUNDLES[PLATFORM]], { env });

  // what went into the installers: the compiled backend, no UI source maps, and it passes the backend's tests
  const staged = JSON.parse(readFileSync(join(root, "src-tauri", "resources", "backend", "backend.json"), "utf8"));
  if (staged.protected !== true || /-none-any\.whl$/.test(staged.wheel)) fail(`the build bundled the backend as source (${staged.wheel})`);
  if (readdirSync(join(root, "dist"), { recursive: true }).some((f) => String(f).endsWith(".map"))) fail("the UI build wrote source maps (dist/**/*.map)");
  if (flag("--skip-tests")) info("tests of the compiled backend skipped");
  else run("node", [join(root, "scripts", "test-bundled-backend.mjs")]);

  const dest = join(OUT, PLATFORM);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const copy = (src, name = src.split(/[\\/]/).pop()) => {
    copyFileSync(src, join(dest, name));
    return name;
  };
  // the file the updater downloads on this platform, and its signature
  const updater = (src, name, keys) => {
    if (!existsSync(`${src}.sig`)) fail(`the build made no ${src}.sig (is createUpdaterArtifacts on?)`);
    const file = copy(src, name);
    const signature = readFileSync(`${src}.sig`, "utf8").trim();
    copy(`${src}.sig`, `${file}.sig`);
    return Object.fromEntries(keys.map((k) => [k, { file, signature }]));
  };

  let platforms;
  if (PLATFORM === "windows") {
    platforms = updater(one(join(bundle, "nsis"), "-setup.exe"), undefined, ["windows-x86_64", "windows-x86_64-nsis"]);
    copy(one(join(bundle, "msi"), ".msi"));
  } else if (PLATFORM === "macos") {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    platforms = updater(one(join(bundle, "macos"), ".app.tar.gz"), `FireVoice_${version}_${arch}.app.tar.gz`, [`darwin-${arch}`, `darwin-${arch}-app`]);
    copy(one(join(bundle, "dmg"), ".dmg"));
  } else {
    platforms = updater(one(join(bundle, "appimage"), ".AppImage"), undefined, ["linux-x86_64", "linux-x86_64-appimage"]);
    copy(one(join(bundle, "deb"), ".deb"));
    copy(one(join(bundle, "rpm"), ".rpm"));
  }
  writeFileSync(join(dest, "platforms.json"), `${JSON.stringify(platforms, null, 2)}\n`);
  info(`staged in release-out/${PLATFORM}/: ${readdirSync(dest).join(", ")}`);
}

// ------------------------------------------------------------------------------------------------ publish
async function publish() {
  const version = plainVersion(arg);
  const tag = `v${version}`;
  const text = notes();

  // every platform's files, side by side
  const dirs = existsSync(OUT) ? readdirSync(OUT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(OUT, d.name)) : [];
  const files = new Map();
  const platforms = {};
  for (const d of dirs) {
    for (const f of readdirSync(d)) {
      if (f === "platforms.json") continue;
      if (files.has(f)) fail(`two platforms built a file named ${f}`);
      files.set(f, join(d, f));
    }
    if (existsSync(join(d, "platforms.json"))) Object.assign(platforms, JSON.parse(readFileSync(join(d, "platforms.json"), "utf8")));
  }
  for (const p of ["windows-x86_64", "darwin-aarch64", "linux-x86_64"]) if (!platforms[p]) fail(`no ${p} build in release-out/`);

  const final = join(OUT, "final");
  rmSync(final, { recursive: true, force: true });
  mkdirSync(final, { recursive: true });
  for (const [f, src] of files) copyFileSync(src, join(final, f));
  const base = `https://github.com/${RELEASES_REPO}/releases/download/${tag}`;
  const latest = {
    version,
    notes: text,
    pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: Object.fromEntries(Object.entries(platforms).map(([k, { file, signature }]) => [k, { signature, url: `${base}/${file}` }])),
  };
  writeFileSync(join(final, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
  writeFileSync(join(final, "notes.md"), `${text}\n`);
  const installers = [...files.keys()].filter((f) => !f.endsWith(".sig")).sort();
  const sums = installers.map((f) => `${createHash("sha256").update(readFileSync(join(final, f))).digest("hex")}  ${f}`);
  writeFileSync(join(final, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
  const assets = [...[...files.keys()].sort(), "latest.json", "SHA256SUMS.txt"];
  info(`release files: ${assets.join(", ")}`);
  if (dry) {
    info("dry run: nothing committed, pushed or published");
    return;
  }

  // the release commit and tag in this repo (kept if a previous run already pushed them)
  if (remoteTag(tag)) info(`${tag} is already pushed; keeping it`);
  else {
    setVersion(version);
    const date = new Date().toISOString().slice(0, 10);
    const cl = join(root, "CHANGELOG.md");
    const old = existsSync(cl) ? readFileSync(cl, "utf8") : "# Changelog\n";
    const [head, ...rest] = old.split(/\n(?=## )/);
    writeFileSync(cl, `${head.trimEnd()}\n\n## ${version} (${date})\n\n${text}\n${rest.length ? `\n${rest.join("\n")}` : ""}`);
    run("git", ["add", ...VERSION_FILES, "CHANGELOG.md"]);
    if (existsSync(join(root, NOTES_FILE))) run("git", ["rm", "-q", NOTES_FILE]);
    run("git", ["commit", "-m", `Release ${tag}`]);
    run("git", ["tag", "-a", tag, "-m", `FireVoice ${version}`]);
    // fails if main moved on while the builds ran: then start the release again from the new main
    run("git", ["push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`]);
    info(`pushed Release ${tag} to main`);
  }

  // the public release
  const paths = assets.map((f) => join(final, f));
  const exists = spawnSync("gh", ["release", "view", tag, "--repo", RELEASES_REPO, "--json", "tagName"], { stdio: "ignore" }).status === 0;
  if (exists) run("gh", ["release", "upload", tag, ...paths, "--repo", RELEASES_REPO, "--clobber"]);
  else run("gh", ["release", "create", tag, ...paths, "--repo", RELEASES_REPO, "--title", `FireVoice ${version}`, "--notes-file", join(final, "notes.md"), "--latest"]);

  let seen = null;
  for (let i = 0; i < 12 && seen !== version; i++) {
    if (i) await new Promise((r) => setTimeout(r, 5000));
    try {
      const r = await fetch(FEED, { redirect: "follow", cache: "no-store" });
      seen = r.ok ? (await r.json()).version : null;
    } catch {
      seen = null;
    }
  }
  if (seen !== version) fail(`the update feed says ${seen ?? "nothing"}, not ${version}. Check https://github.com/${RELEASES_REPO}/releases`);
  info(`done: FireVoice ${version} is live for Windows, macOS and Linux.`);
}

if (cmd === "plan") plan();
else if (cmd === "build") build();
else if (cmd === "publish") await publish();
else fail("usage: node scripts/ci-release.mjs plan|build|publish <version> [--dry-run] [--skip-tests]");
