export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "page";
}

/** Turns a question or phrase into a short page title. */
export function titleFromQuestion(q: string): string {
  const t = q.trim().replace(/\s+/g, " ");
  if (!t) return "Untitled";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * A free `.md` path for `base` in `dir`. Free ignores case: macOS volumes do, so `sleep.md` is the
 * same file as a reader's own `Sleep.md`, and writing it would replace that note.
 */
export function uniquePath(base: string, taken: Set<string>, dir = ""): string {
  const prefix = dir ? dir.replace(/\/+$/, "") + "/" : "";
  const lower = new Set([...taken].map((p) => p.toLowerCase()));
  let candidate = `${prefix}${base}.md`;
  let i = 2;
  while (lower.has(candidate.toLowerCase())) {
    candidate = `${prefix}${base}-${i}.md`;
    i += 1;
  }
  return candidate;
}

/**
 * Writes a new page under the first free name for `base` and gives back its path. The app's list
 * can be behind the folder, so `create` must refuse, with `false`, a name already on disk. That
 * name is then skipped for the next one, a few times, before giving up.
 */
export async function createUnique(
  base: string,
  taken: Set<string>,
  dir: string,
  create: (path: string) => Promise<boolean>,
  tries = 5,
): Promise<string> {
  const skip = new Set(taken);
  for (let i = 0; i < tries; i++) {
    const path = uniquePath(base, skip, dir);
    if (await create(path)) return path;
    skip.add(path);
  }
  throw new Error(`Couldn't make the page: ${uniquePath(base, taken, dir)} and the next ${tries - 1} names after it are already in the folder.`);
}
