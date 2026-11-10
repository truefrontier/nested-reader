// Writes THIRD_PARTY_NOTICES.md: every package the shipped app carries, grouped by license, with
// the license and notice files each one ships. Run it after any change to src-tauri/Cargo.lock or
// pnpm-lock.yaml: `node scripts/third-party-notices.mjs`.
//
// What counts as shipped:
// - Rust: crates reached from the app crate through normal dependencies only, on both Mac targets
//   the release builds (release.yml builds a universal app). Build scripts' and tests' dependencies
//   are left out. Proc-macro crates are kept, since telling them apart buys little.
// - JavaScript: `pnpm licenses list --prod`, the packages Vite can bundle into the window.
//
// It also writes scripts/third-party-notices.not-shipped.json, the lockfile packages it left out
// and why, so src/thirdPartyNotices.test.ts can tell a new dependency from a known one.
//
// A package that ships no license file gets its text from scripts/third-party-licenses/<name>@<version>/
// (see scripts/license-texts.ts). With neither, this stops and writes nothing: every package the
// notices list comes with its license text.
//
// Offline only: `cargo metadata --offline` reads crates already in ~/.cargo. If it says a crate
// can't be downloaded, run `cargo fetch` in src-tauri once and try again.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireTexts } from "./license-texts.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin"];

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] });

/** @type {Map<string, {name: string, version: string, kind: string, license: string, dir: string, extra?: string}>} */
const shipped = new Map();
const notShipped = { cargo: {}, npm: {} };

// Rust: one resolve per Mac target, walking only normal edges from the workspace.
const onMac = new Set();
for (const target of TARGETS) {
  const meta = JSON.parse(run("cargo", ["metadata", "--offline", "--format-version", "1", "--filter-platform", target], join(ROOT, "src-tauri")));
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const todo = [...meta.workspace_members];
  while (todo.length) {
    const id = todo.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id).deps) if (d.dep_kinds.some((k) => k.kind === null)) todo.push(d.pkg);
  }
  for (const p of meta.packages) onMac.add(`${p.name}@${p.version}`);
  for (const id of seen) {
    if (meta.workspace_members.includes(id)) continue;
    const p = pkgs.get(id);
    shipped.set(`${p.name}@${p.version}`, {
      name: p.name,
      version: p.version,
      kind: "Rust crate",
      license: p.license ?? "",
      dir: dirname(p.manifest_path),
      extra: p.license_file ?? undefined,
    });
  }
}
for (const m of readFileSync(join(ROOT, "src-tauri/Cargo.lock"), "utf8").matchAll(/^name = "(.+)"\nversion = "(.+)"\nsource = /gm)) {
  const key = `${m[1]}@${m[2]}`;
  if (!shipped.has(key)) notShipped.cargo[key] = onMac.has(key) ? "build or test only" : "not used on macOS";
}

// JavaScript: pnpm's production list, with the folder each package is installed in.
const prod = JSON.parse(run("pnpm", ["licenses", "list", "--prod", "--json"], ROOT));
for (const list of Object.values(prod)) {
  for (const p of list) {
    p.versions.forEach((version, i) => {
      shipped.set(`${p.name}@${version}`, { name: p.name, version, kind: "npm package", license: p.license ?? "", dir: p.paths[i] });
    });
  }
}
const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
const packagesBlock = lock.slice(lock.indexOf("\npackages:\n"), lock.indexOf("\nsnapshots:\n"));
for (const m of packagesBlock.matchAll(/^ {2}'?([^\s']+)'?:$/gm)) {
  if (!shipped.has(m[1])) notShipped.npm[m[1]] = "build or test only";
}

/** "MIT/Apache-2.0", "(Apache-2.0 OR MIT)" and "MIT OR Apache-2.0" are one license choice. */
function normalizeLicense(expr) {
  let s = expr.trim().replace(/\s*\/\s*/g, " OR ");
  if (/^\(([^()]*)\)$/.test(s)) s = s.slice(1, -1);
  if (!s) return "No license declared";
  if (/[()]| AND | WITH /.test(s)) return s;
  return [...new Set(s.split(" OR ").map((x) => x.trim()))].sort().join(" OR ");
}

const fence = (text) => {
  let f = "```";
  while (text.includes(f)) f += "`";
  return `${f}text\n${text}\n${f}`;
};

const found = requireTexts([...shipped.values()]);
const groups = new Map();
for (const pkg of shipped.values()) {
  const license = normalizeLicense(pkg.license);
  if (!groups.has(license)) groups.set(license, []);
  groups.get(license).push(pkg);
}
const byName = (a, b) => (a.name === b.name ? a.version.localeCompare(b.version, "en", { numeric: true }) : a.name < b.name ? -1 : 1);
const licenses = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length || (a < b ? -1 : 1));

const out = [
  "# Third-party notices",
  "",
  "Nested is built with the open-source packages below: the Rust crates compiled into the app and the JavaScript bundled into its window. They are grouped by license. Each group lists its packages, then the license and notice files those packages ship, with packages that ship the same text sharing one copy. For a package that ships none, the text comes from its source repository or, where that has none either, from the license its manifest declares; `scripts/third-party-licenses` keeps those, each with a SOURCE file saying where it came from.",
  "",
  "This file is generated by `node scripts/third-party-notices.mjs` from `src-tauri/Cargo.lock` and `pnpm-lock.yaml`. Don't edit it by hand.",
  "",
  "| License | Packages |",
  "| --- | --- |",
  ...licenses.map((l) => `| ${l} | ${groups.get(l).length} |`),
];
for (const license of licenses) {
  const pkgs = groups.get(license).sort(byName);
  out.push("", `## ${license}`, "");
  // Keyed with whitespace folded, so two copies of a text that differ only in wrapping print once.
  const texts = new Map();
  for (const pkg of pkgs) {
    const { texts: own, upstream } = found.get(pkg);
    out.push(`- \`${pkg.name}@${pkg.version}\` (${pkg.kind})${upstream ? ", no license file in the package: text from scripts/third-party-licenses" : ""}`);
    for (const text of own) {
      const key = text.replace(/\s+/g, " ");
      if (!texts.has(key)) texts.set(key, { text, users: [] });
      if (!texts.get(key).users.includes(pkg)) texts.get(key).users.push(pkg);
    }
  }
  for (const { text, users } of texts.values()) {
    const names = users.map((p) => `\`${p.name}@${p.version}\``).join(", ");
    out.push("", `### Text shipped by ${names}`, "", fence(text));
  }
}

writeFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), `${out.join("\n")}\n`);
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(
  join(ROOT, "scripts/third-party-notices.not-shipped.json"),
  `${JSON.stringify({ cargo: sorted(notShipped.cargo), npm: sorted(notShipped.npm) }, null, 2)}\n`,
);
const count = (kind) => [...shipped.values()].filter((p) => p.kind === kind).length;
console.log(`${count("Rust crate")} crates and ${count("npm package")} npm packages under ${licenses.length} licenses; ${Object.keys(notShipped.cargo).length + Object.keys(notShipped.npm).length} lockfile packages don't ship.`);
