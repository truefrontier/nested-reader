// Fetches the license files of crates that ship none into scripts/third-party-licenses/<name>@<version>/,
// where scripts/third-party-notices.mjs looks when a package has no license file of its own.
//
//   node scripts/fetch-upstream-licenses.mjs objc2@0.6.4 block2@0.6.2 ...
//
// Each crate on crates.io records the commit it was published from (.cargo_vcs_info.json). This reads
// that commit on GitHub with `gh api` (GET only), starting at the crate's own folder and moving up to the
// repository root, and keeps the license files of the first folder that has any. It also writes SOURCE,
// the commit and folder they came from. The crate must already be in ~/.cargo (run `cargo fetch` first).
//
// Crates published without commit info, npm packages, and repositories with no license file anywhere
// are left for a person: the script says so, and the text goes in by hand with a SOURCE saying where
// it came from.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "third-party-licenses");
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)/i;
const REGISTRY = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "registry/src");

const gh = (path, raw = false) =>
  execFileSync("gh", ["api", ...(raw ? ["-H", "Accept: application/vnd.github.raw+json"] : []), path], { encoding: "utf8", maxBuffer: 1 << 26 });

let failed = false;
for (const key of process.argv.slice(2)) {
  const at = key.lastIndexOf("@");
  const [name, version] = [key.slice(0, at), key.slice(at + 1)];
  const crate = readdirSync(REGISTRY).map((r) => join(REGISTRY, r, `${name}-${version}`)).find(existsSync);
  const vcs = crate && join(crate, ".cargo_vcs_info.json");
  if (!vcs || !existsSync(vcs)) {
    console.error(`${key}: not a crate in ${REGISTRY} with a published commit; add its text by hand.`);
    failed = true;
    continue;
  }
  const { git, path_in_vcs: inVcs = "" } = JSON.parse(readFileSync(vcs, "utf8"));
  const repo = /^repository\s*=\s*"https:\/\/github\.com\/([^/"]+\/[^/"]+?)(?:\.git)?\/?"/m.exec(readFileSync(join(crate, "Cargo.toml"), "utf8"))?.[1];
  if (!repo) {
    console.error(`${key}: its repository isn't on GitHub; add its text by hand.`);
    failed = true;
    continue;
  }
  // The crate's own folder first, then each folder above it up to the root ("").
  const folders = inVcs.split("/").filter(Boolean).map((_, i, parts) => parts.slice(0, parts.length - i).join("/"));
  folders.push("");
  let found;
  for (const folder of folders) {
    const files = JSON.parse(gh(`repos/${repo}/contents/${folder}?ref=${git.sha1}`)).filter((f) => f.type === "file" && LICENSE_FILE.test(f.name));
    if (files.length) {
      found = { folder, files };
      break;
    }
  }
  if (!found) {
    console.error(`${key}: no license file in ${repo} at ${git.sha1}; add its text by hand.`);
    failed = true;
    continue;
  }
  const dir = join(OUT, key);
  mkdirSync(dir, { recursive: true });
  for (const f of found.files) writeFileSync(join(dir, f.name), gh(`repos/${repo}/contents/${f.path}?ref=${git.sha1}`, true));
  const names = found.files.map((f) => f.name).join(", ");
  writeFileSync(join(dir, "SOURCE"), `https://github.com/${repo}/tree/${git.sha1}/${found.folder}\n${names}, from the commit ${key} was published from.\n`);
  console.log(`${key}: ${names} from ${repo} ${found.folder || "(root)"} at ${git.sha1.slice(0, 7)}`);
}
if (failed) process.exitCode = 1;
