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

export function uniquePath(base: string, taken: Set<string>, dir = ""): string {
  const prefix = dir ? dir.replace(/\/+$/, "") + "/" : "";
  let candidate = `${prefix}${base}.md`;
  let i = 2;
  while (taken.has(candidate)) {
    candidate = `${prefix}${base}-${i}.md`;
    i += 1;
  }
  return candidate;
}
