// Where scripts/third-party-notices.mjs finds each package's license texts. Kept apart from the
// generator, which runs cargo and pnpm as it loads, so src/thirdPartyNotices.test.ts can test it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** One `<name>@<version>` folder per package that ships no license file, with its text from upstream. */
export const UPSTREAM_DIR = fileURLToPath(new URL("third-party-licenses", import.meta.url));

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)/i;

export interface Package {
  name: string;
  version: string;
  /** The folder the package is installed in. */
  dir: string;
  /** A license file the manifest names, relative to `dir`, if it isn't found by name. */
  extra?: string;
}

export interface Texts {
  texts: string[];
  /** The texts came from the package's folder in UPSTREAM_DIR, not the package. */
  upstream: boolean;
}

function readTexts(dir: string, extra?: string): string[] {
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort();
  if (extra && !files.includes(extra)) files.push(extra);
  return files.map((f) =>
    readFileSync(join(dir, f), "utf8")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .trim(),
  );
}

/** A package's license and notice texts: the files it ships, or else its folder under `upstream`. */
export function licenseTexts(pkg: Package, upstream = UPSTREAM_DIR): Texts {
  const own = readTexts(pkg.dir, pkg.extra);
  if (own.length) return { texts: own, upstream: false };
  const folder = join(upstream, `${pkg.name}@${pkg.version}`);
  return { texts: existsSync(folder) ? readTexts(folder) : [], upstream: true };
}

/** Every package's texts. Throws naming each package with none from either place, so no notice goes out without one. */
export function requireTexts<P extends Package>(pkgs: P[], upstream = UPSTREAM_DIR): Map<P, Texts> {
  const found = new Map(pkgs.map((p) => [p, licenseTexts(p, upstream)]));
  const missing = pkgs.filter((p) => !found.get(p)!.texts.length).map((p) => `${p.name}@${p.version}`);
  if (missing.length) {
    throw new Error(
      `No license text for ${missing.join(", ")}: the package ships no license file and ${upstream} has no folder for it. ` +
        "Fetch one with `node scripts/fetch-upstream-licenses.mjs <name>@<version>`, or add it by hand with a SOURCE saying where it came from.",
    );
  }
  return found;
}
