// The FireVoice version lives in six files; this keeps them in step.
//
//   node scripts/version.mjs                 show every version and fail if they differ
//   node scripts/version.mjs 1.5.0           set an exact version
//   node scripts/version.mjs patch|minor|major
//
// Versions are plain MAJOR.MINOR.PATCH: the Windows MSI installer accepts nothing else.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Each file, how to read its version, and how to write a new one. */
const FILES = [
  { file: "package.json", re: /^(\s*"version":\s*")([^"]+)(")/m },
  { file: "src-tauri/tauri.conf.json", re: /^(\s*"version":\s*")([^"]+)(")/m },
  { file: "src-tauri/Cargo.toml", re: /^(version\s*=\s*")([^"]+)(")/m },
  { file: "src-tauri/Cargo.lock", re: /(name = "firevoice-desktop"\r?\nversion = ")([^"]+)(")/ },
  { file: "backend/pyproject.toml", re: /^(version\s*=\s*")([^"]+)(")/m },
  { file: "backend/src/firevoice/__init__.py", re: /^(__version__\s*=\s*")([^"]+)(")/m },
];

export function readVersions() {
  return FILES.map(({ file, re }) => {
    const m = readFileSync(join(root, file), "utf8").match(re);
    if (!m) throw new Error(`no version found in ${file}`);
    return { file, version: m[2] };
  });
}

/** The one current version, or an error naming the files that disagree. */
export function currentVersion() {
  const all = readVersions();
  const set = new Set(all.map((v) => v.version));
  if (set.size !== 1) throw new Error(`versions differ:\n${all.map((v) => `  ${v.version}  ${v.file}`).join("\n")}`);
  return all[0].version;
}

export const isPlain = (v) => /^\d+\.\d+\.\d+$/.test(v);

export function nextVersion(current, how) {
  if (isPlain(how)) return how;
  const [a, b, c] = current.split(".").map(Number);
  if (how === "patch") return `${a}.${b}.${c + 1}`;
  if (how === "minor") return `${a}.${b + 1}.0`;
  if (how === "major") return `${a + 1}.0.0`;
  throw new Error(`"${how}" is not a version: use MAJOR.MINOR.PATCH, patch, minor or major`);
}

/** semver order for plain versions: -1, 0, 1 */
export function compare(x, y) {
  const a = x.split(".").map(Number);
  const b = y.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export function setVersion(v) {
  if (!isPlain(v)) throw new Error(`${v} is not MAJOR.MINOR.PATCH`);
  for (const { file, re } of FILES) {
    const p = join(root, file);
    const s = readFileSync(p, "utf8");
    writeFileSync(p, s.replace(re, (_, a, _old, c) => `${a}${v}${c}`));
  }
  return currentVersion();
}

export const VERSION_FILES = FILES.map((f) => f.file);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  try {
    if (!arg) {
      for (const { file, version } of readVersions()) console.log(`${version.padEnd(10)} ${file}`);
      console.log(`\ncurrent: ${currentVersion()}`);
    } else {
      const v = setVersion(nextVersion(currentVersion(), arg));
      console.log(`version set to ${v} in ${FILES.length} files`);
    }
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
