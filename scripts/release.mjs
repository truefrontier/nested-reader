// Cuts a release: bumps the version in every file that carries it, commits, tags and pushes.
// GitHub Actions (.github/workflows/release.yml) builds and publishes from the tag.
//
//   pnpm release 0.2.0        this exact version
//   pnpm release patch        0.1.0 → 0.1.1; also minor and major
//   pnpm release 0.2.0 --dry  show what would change, touch nothing
//
// Runs from a clean checkout of main, so the release is what is on GitHub.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FILES = {
  package: "package.json",
  tauri: "src-tauri/tauri.conf.json",
  cargo: "src-tauri/Cargo.toml",
  lock: "src-tauri/Cargo.lock",
};

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const want = args.find((a) => !a.startsWith("--"));
if (!want) {
  console.error("Usage: pnpm release <version | patch | minor | major> [--dry]");
  process.exit(2);
}

const current = JSON.parse(readFileSync(FILES.package, "utf8")).version;
const next = bump(current, want);
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`"${want}" is not a version like 1.2.3, nor patch, minor or major.`);
  process.exit(2);
}
if (!greater(next, current)) {
  console.error(`${next} is not newer than the current ${current}.`);
  process.exit(2);
}

const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const branch = sh("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") stop(`Release from main, not ${branch}.`);
if (sh("git status --porcelain")) stop("Commit or stash your changes first; the working tree must be clean.");
if (sh(`git tag -l v${next}`)) stop(`Tag v${next} already exists.`);

console.log(`${current} → ${next}${dry ? " (dry run)" : ""}`);

edit(FILES.package, (s) => s.replace(/"version": "[^"]+"/, `"version": "${next}"`));
edit(FILES.tauri, (s) => s.replace(/"version": "[^"]+"/, `"version": "${next}"`));
edit(FILES.cargo, (s) => s.replace(/^version = "[^"]+"/m, `version = "${next}"`));
// Cargo.lock lists the crate's own version too; editing it here keeps `cargo build` from rewriting the file.
edit(FILES.lock, (s) => s.replace(/(\[\[package\]\]\nname = "nested"\nversion = ")[^"]+(")/, `$1${next}$2`));

if (dry) process.exit(0);

sh(`git add ${Object.values(FILES).join(" ")}`);
sh(`git commit -q -m "Nested ${next}"`);
sh(`git tag -a v${next} -m "Nested ${next}"`);
try {
  sh("git push -q origin main");
  sh(`git push -q origin v${next}`);
} catch {
  stop(`Committed and tagged v${next}, but the push failed. When you are online: git push origin main v${next}`);
}
console.log(`Tagged v${next} and pushed. GitHub Actions is building the release:`);
console.log(`  ${sh("git remote get-url origin").replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/")}/actions`);

function edit(file, fn) {
  const before = readFileSync(file, "utf8");
  const after = fn(before);
  if (after === before) stop(`Couldn't find the version in ${file}.`);
  console.log(`  ${file}`);
  if (!dry) writeFileSync(file, after);
}

function bump(v, want) {
  const [major, minor, patch] = v.split(".").map(Number);
  switch (want) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      return want;
  }
}

function greater(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function stop(why) {
  console.error(why);
  process.exit(1);
}
