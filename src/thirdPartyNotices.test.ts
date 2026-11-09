import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// THIRD_PARTY_NOTICES.md ships inside the app. These fail when a lockfile gains or bumps a package
// that neither the notices nor the generator's not-shipped list accounts for. The fix is to run
// `node scripts/third-party-notices.mjs`, which rewrites both.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const notices = read("THIRD_PARTY_NOTICES.md");
const noticed = new Set(Array.from(notices.matchAll(/^- `([^`]+)`/gm), (m) => m[1]));
/** The names (versions dropped) of the noticed packages of one kind. */
const noticedNames = (kind: "Rust crate" | "npm package") => new Set(Array.from(notices.matchAll(new RegExp(`^- \`(.+)@[^@\`]+\` \\(${kind}\\)`, "gm")), (m) => m[1]));
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
// still listed, as "build or test only". The manifests say what the app itself depends on, so check those too.
test("every runtime crate Cargo.toml names has a notice", () => {
  let section = "";
  const direct: string[] = [];
  for (const line of read("src-tauri/Cargo.toml").split("\n")) {
    const header = /^\[(.+)\]\s*$/.exec(line);
    if (header) section = header[1];
    // The app's own dependencies, and the ones it takes only on macOS, the one platform it ships for.
    else if (section === "dependencies" || section === `target.'cfg(target_os = "macos")'.dependencies`) {
      const name = /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
      if (name) direct.push(name);
    }
  }
  assert.ok(direct.includes("tauri") && direct.includes("objc2"), "Cargo.toml should parse into its dependencies");
  const crates = noticedNames("Rust crate");
  assert.deepEqual(direct.filter((name) => !crates.has(name)), []);
});

test("every dependency package.json names has a notice", () => {
  const direct = Object.keys(JSON.parse(read("package.json")).dependencies ?? {});
  assert.ok(direct.includes("react"), "package.json should list its dependencies");
  const npm = noticedNames("npm package");
  assert.deepEqual(direct.filter((name) => !npm.has(name)), []);
});
