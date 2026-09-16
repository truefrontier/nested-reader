/**
 * The session map: a page-by-page index of the folder, small enough to ride along in every prompt.
 *
 * The context block can only carry so many page bodies, and past that the model has no idea the
 * rest of the folder exists — it cannot ask for a page it has never heard of. The map fixes that:
 * every page is named, the ones nearest the question are described, and the model can fetch any of
 * the others with `read_page`. Most of it costs nothing, being what the front matter already says;
 * only the one-line `about:` is written by a model, and only for pages whose text has changed.
 */

import type { PageMeta } from "../platform/types";
import { queryTerms, rankByRelevance } from "./rank";

/** One page's line, and the fingerprint of the text it was written for. */
export type PageSummary = { about: string; for: string };
export type SummaryCache = Record<string, PageSummary>;

/**
 * A cheap content fingerprint (FNV-1a). Only ever compared against itself, so it needs to change
 * when the page changes and nothing more.
 */
export function fingerprint(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Whether the line held for a page was written for the text the page holds now. */
export function summaryIsCurrent(cache: SummaryCache, path: string, body: string): boolean {
  const held = cache[path];
  return !!held && held.for === fingerprint(body);
}

function shortDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The `from: … · changed … · N revisions` line, with whatever of it is actually known. */
function provenance(p: PageMeta, revisions?: number): string {
  const bits: string[] = [];
  if (p.source) bits.push(`from: ${p.source}`);
  const changed = shortDate(p.modified);
  if (changed) bits.push(`changed ${changed}`);
  if (revisions && revisions > 0) bits.push(`${revisions} revision${revisions === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

function entry(p: PageMeta, cache: SummaryCache, revisions?: number): string {
  const lines = [`## ${p.path} — ${p.title}`];
  if (p.question) lines.push(`asks: ${p.question}`);
  const about = cache[p.path]?.about;
  if (about) lines.push(`about: ${about}`);
  const from = provenance(p, revisions);
  if (from) lines.push(from);
  return lines.join("\n");
}

/** Pages in a stable order, so the file on disk only changes when the session does. */
function ordered(pages: PageMeta[]): PageMeta[] {
  return [...pages].sort((a, b) => a.path.localeCompare(b.path));
}

/** The whole map, for `.reader/map.md`. No budget: it is a file, not a prompt. */
export function sessionMap(pages: PageMeta[], cache: SummaryCache, revisions: Record<string, number> = {}): string {
  const list = ordered(pages);
  const head = `# Session map\n${new Date().toISOString().slice(0, 10)} · ${list.length} page${list.length === 1 ? "" : "s"}`;
  if (!list.length) return `${head}\n\nNothing in the session yet.`;
  return [head, ...list.map((p) => entry(p, cache, revisions[p.path]))].join("\n\n");
}

/**
 * The map as it goes into a prompt. Every page is named whatever happens — that part is a line
 * each and it is the whole point — while the fuller entries go to the pages closest to what was
 * asked, until `budget` runs out. `except` drops the page already quoted in full above.
 */
export function sessionMapForPrompt(
  pages: PageMeta[],
  cache: SummaryCache,
  query: string,
  budget: number,
  except?: string,
  revisions: Record<string, number> = {},
): string {
  const list = ordered(pages).filter((p) => p.path !== except);
  if (!list.length) return "";

  const ranked = rankByRelevance(
    queryTerms(query),
    list,
    (p) => `${p.title} ${p.question ?? ""} ${cache[p.path]?.about ?? ""}`,
    (p) => p.title,
  );

  const parts: string[] = [];
  const detailed = new Set<string>();
  let used = 0;
  for (const p of ranked) {
    const text = entry(p, cache, revisions[p.path]);
    if (used + text.length > budget) break;
    used += text.length;
    detailed.add(p.path);
    parts.push(text);
  }

  // Everything else still gets named, so the model knows it can go and read it.
  const rest = list.filter((p) => !detailed.has(p.path));
  const head = `# Session map\n${list.length} other page${list.length === 1 ? "" : "s"} in the session.${
    rest.length ? " The ones below the line are named only; read any of them with the tools if it would help." : ""
  }`;
  const tail = rest.length ? `## Also in the session\n${rest.map((p) => `${p.path} — ${p.title}`).join("\n")}` : "";
  return [head, ...parts, tail].filter(Boolean).join("\n\n");
}
