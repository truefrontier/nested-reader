import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// THIRD_PARTY_NOTICES.md ships inside the app. These fail when a lockfile gains or bumps a package
// that neither the notices nor the generator's not-shipped list accounts for. The fix is to run
// `node scripts/third-party-notices.mjs`, which rewrites both.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const notices = read("THIRD_PARTY_NOTICES.md");
const noticed = new Set(Array.from(notices.matchAll(/^- `([^`]+)`/gm), (m) => m[1]));
const notShipped = JSON.parse(read("scripts/third-party-notices.not-shipped.json")) as Record<"cargo" | "npm", Record<string, string>>;
// Every `name@version` each lockfile holds. The app's own crate has no `source`, so it isn't one.
const cargoLock = read("src-tauri/Cargo.lock");
const crates = Array.from(cargoLock.matchAll(/^name = "(.+)"\nversion = "(.+)"\nsource = /gm), (m) => `${m[1]}@${m[2]}`);
const pnpmLock = read("pnpm-lock.yaml");
const pnpmPackages = pnpmLock.slice(pnpmLock.indexOf("\npackages:\n"), pnpmLock.indexOf("\nsnapshots:\n"));
const packages = Array.from(pnpmPackages.matchAll(/^ {2}'?([^\s']+)'?:$/gm), (m) => m[1]);

test("every crate in Cargo.lock is in the notices or known not to ship", () => {
  assert.ok(crates.length > 100, "Cargo.lock should parse into its crates");
  assert.deepEqual(crates.filter((c) => !noticed.has(c) && !(c in notShipped.cargo)), []);
});

test("every package in pnpm-lock.yaml is in the notices or known not to ship", () => {
  assert.ok(packages.length > 100, "pnpm-lock.yaml should parse into its packages");
  assert.deepEqual(packages.filter((p) => !noticed.has(p) && !(p in notShipped.npm)), []);
});

// The other way round: a package dropped or bumped would otherwise leave its old notice (or not-shipped
// entry) behind, and the file would list what the app no longer ships.
test("every package the notices or the not-shipped list name is still in a lockfile", () => {
  const locked = new Set([...crates, ...packages]);
  const named = [...noticed, ...Object.keys(notShipped.cargo), ...Object.keys(notShipped.npm)];
  assert.deepEqual(named.filter((p) => !locked.has(p)), []);
});

test("the notices are bundled into the app", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(conf.bundle.resources["../THIRD_PARTY_NOTICES.md"], "THIRD_PARTY_NOTICES.md");
});

// The lockfile tests above can't see a package move from dev-only to runtime at the same version: it is
// still listed, as "build or test only". The manifests say what the app itself depends on, and the lockfiles
// say which version of each it gets, so every such name@version needs a notice too. A name another version
// of which ships doesn't count: `security-framework` 3 is noticed, its build-only 2 isn't.

/**
 * Whether a Cargo.toml target section (`'cfg(…)'`, or none) can apply to the macOS build. Only a section that
 * names other platforms and nothing else is left out; a `not(…)` or anything unrecognised counts, since
 * asking for a notice too many is the safe side of this check.
 */
const onMac = (target?: string) => !target || /macos|unix|apple|not\(/.test(target) || !/windows|linux|android|ios|wasm/.test(target);

/**
 * The crates Cargo.toml makes the app's own: under `[dependencies]`, `[dependencies.<name>]` and the target
 * sections that can apply on macOS, with dotted keys (`foo.workspace = true`) and `package = "…"` renames.
 */
function runtimeCrates(toml: string): string[] {
  let section = "";
  const out = new Set<string>();
  for (const line of toml.split("\n")) {
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      section = header[1].trim();
      const table = /^(?:target\.(.+)\.)?dependencies\.([A-Za-z0-9_-]+)$/.exec(section);
      if (table && onMac(table[1])) out.add(table[2]);
      continue;
    }
    const deps = /^(?:target\.(.+)\.)?dependencies$/.exec(section);
    if (!deps || !onMac(deps[1])) continue;
    const key = /^([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)*\s*=(.*)$/.exec(line);
    if (key) out.add(/package\s*=\s*"([^"]+)"/.exec(key[2])?.[1] ?? key[1]);
  }
  return [...out];
}

test("every runtime crate Cargo.toml names has a notice for the version Cargo.lock gives it", () => {
  const direct = runtimeCrates(read("src-tauri/Cargo.toml"));
  assert.ok(direct.includes("tauri") && direct.includes("objc2"), "Cargo.toml should parse into its dependencies");
  // The app's own entry in Cargo.lock lists what it depends on, with a version where the name is ambiguous.
  const own = /^name = "nested"\nversion = .*\ndependencies = \[\n([\s\S]*?)\n\]/m.exec(cargoLock)?.[1] ?? "";
  const ownDeps = Array.from(own.matchAll(/"([^"]+)"/g), (m) => m[1].split(" "));
  const missing = direct.flatMap((name) => {
    const entries = ownDeps.filter(([n]) => n === name);
    if (!entries.length) return [`${name} (not in Cargo.lock's dependencies of nested)`];
    return entries.map(([, version]) => `${name}@${version ?? crates.find((c) => c.startsWith(`${name}@`))?.slice(name.length + 1)}`).filter((c) => !noticed.has(c));
  });
  assert.deepEqual(missing, []);
});

test("every dependency package.json names has a notice for the version pnpm-lock.yaml gives it", () => {
  const direct = Object.keys(JSON.parse(read("package.json")).dependencies ?? {});
  assert.ok(direct.includes("react"), "package.json should list its dependencies");
  // pnpm-lock.yaml's importer for the app: each dependency's resolved version, peer suffix dropped.
  const importer = pnpmLock.slice(pnpmLock.indexOf("\n  .:\n"), pnpmLock.indexOf("\npackages:\n"));
  const header = "\n    dependencies:";
  const deps = importer.slice(importer.indexOf(header) + header.length).split(/\n {4}\S/)[0];
  const resolved = new Map(Array.from(deps.matchAll(/^ {6}'?([^\s']+?)'?:\n {8}specifier: .*\n {8}version: ([^\s(]+)/gm), (m) => [m[1], m[2]]));
  const missing = direct.map((name) => (resolved.has(name) ? `${name}@${resolved.get(name)}` : `${name} (not in pnpm-lock.yaml's dependencies)`)).filter((p) => !noticed.has(p));
  assert.deepEqual(missing, []);
});
