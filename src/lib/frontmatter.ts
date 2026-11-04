import type { PageMeta } from "../platform/types";

export type ParsedPage = { meta: Record<string, string>; body: string };

/**
 * Takes the blank line after the closing fence with it, since `serializeFrontMatter` writes one: left
 * in the body, it would be written back with another in front of it, one more line on every save.
 */
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?(?:\r?\n)?/;

export function parseFrontMatter(raw: string): ParsedPage {
  const m = FENCE.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      // serializeFrontMatter writes these as JSON strings, so quotes and backslashes inside are escaped.
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      // YAML single quotes double a quote to escape it.
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    meta[key] = value;
  }
  return { meta, body: raw.slice(m[0].length) };
}

export function serializeFrontMatter(meta: Record<string, string | undefined>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === "") continue;
    const needsQuotes = /[:#"'\n]/.test(v) || v.trim() !== v;
    lines.push(`${k}: ${needsQuotes ? JSON.stringify(v) : v}`);
  }
  return lines.length ? `---\n${lines.join("\n")}\n---\n\n` : "";
}

/** The first level-1 heading, passing over code blocks, where `# ` starts a shell comment. */
export function titleFromBody(body: string, fallback: string): string {
  let fence = "";
  for (const line of body.split(/\r?\n/)) {
    const f = /^\s*(```|~~~)/.exec(line)?.[1];
    if (f && (!fence || f === fence)) fence = fence ? "" : f;
    if (f || fence) continue;
    const m = /^\s*#[ \t]+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return fallback;
}

export function titleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function metaFromRaw(path: string, raw: string, modified?: string): { meta: PageMeta; body: string } {
  const { meta, body } = parseFrontMatter(raw);
  const mode = meta.mode === "deep-dive" || meta.mode === "new-page" ? meta.mode : undefined;
  return {
    meta: {
      path,
      title: meta.title || titleFromBody(body, titleFromPath(path)),
      source: meta.source || undefined,
      question: meta.question || undefined,
      created: meta.created || undefined,
      modified,
      mode,
    },
    body,
  };
}

export function serializePage(meta: PageMeta, body: string): string {
  return (
    serializeFrontMatter({
      title: meta.title,
      source: meta.source,
      question: meta.question,
      created: meta.created,
      mode: meta.mode,
    }) + body
  );
}
