import type { PageMeta } from "../platform/types";

export type ParsedPage = { meta: Record<string, string>; body: string };

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontMatter(raw: string): ParsedPage {
  const m = FENCE.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
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

export function titleFromBody(body: string, fallback: string): string {
  const m = /^\s*#\s+(.+?)\s*$/m.exec(body);
  return m ? m[1].trim() : fallback;
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
