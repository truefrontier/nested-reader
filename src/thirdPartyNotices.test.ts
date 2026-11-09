import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// THIRD_PARTY_NOTICES.md ships inside the app. These fail when a lockfile gains or bumps a package
// that neither the notices nor the generator's not-shipped list accounts for. The fix is to run
// `node scripts/third-party-notices.mjs`, which rewrites both.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const noticed = new Set(Array.from(read("THIRD_PARTY_NOTICES.md").matchAll(/^- `([^`]+)`/gm), (m) => m[1]));
const notShipped = JSON.parse(read("scripts/third-party-notices.not-shipped.json")) as Record<"cargo" | "npm", Record<string, string>>;

test("every crate in Cargo.lock is in the notices or known not to ship", () => {
  const lock = read("src-tauri/Cargo.lock");
  const crates = Array.from(lock.matchAll(/^name = "(.+)"\nversion = "(.+)"\nsource = /gm), (m) => `${m[1]}@${m[2]}`);
  assert.ok(crates.length > 100, "Cargo.lock should parse into its crates");
  assert.deepEqual(crates.filter((c) => !noticed.has(c) && !(c in notShipped.cargo)), []);
});

test("every package in pnpm-lock.yaml is in the notices or known not to ship", () => {
  const lock = read("pnpm-lock.yaml");
  const block = lock.slice(lock.indexOf("\npackages:\n"), lock.indexOf("\nsnapshots:\n"));
  const packages = Array.from(block.matchAll(/^ {2}'?([^\s']+)'?:$/gm), (m) => m[1]);
  assert.ok(packages.length > 100, "pnpm-lock.yaml should parse into its packages");
  assert.deepEqual(packages.filter((p) => !noticed.has(p) && !(p in notShipped.npm)), []);
});

test("the notices are bundled into the app", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(conf.bundle.resources["../THIRD_PARTY_NOTICES.md"], "THIRD_PARTY_NOTICES.md");
});
