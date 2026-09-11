import { marked, type Tokens, type TokensList } from "marked";
import DOMPurify from "dompurify";

export type Block = {
  /** Markdown source of this block, exactly as in the body. */
  raw: string;
  html: string;
  /** Plain text of the rendered block, for diffing and selection offsets. */
  text: string;
  type: string;
};

type WikiToken = Tokens.Generic & { target: string; text: string };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

marked.use({
  gfm: true,
  breaks: false,
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start(src: string) {
        const i = src.indexOf("[[");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string) {
        const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(src);
        if (!m) return undefined;
        const tok: WikiToken = { type: "wikilink", raw: m[0], target: m[1].trim(), text: (m[2] ?? m[1]).trim() };
        return tok;
      },
      renderer(token) {
        const t = token as WikiToken;
        return `<a class="wl" href="#" data-target="${escapeHtml(t.target)}">${escapeHtml(t.text)}</a>`;
      },
    },
  ],
});

const scratch = typeof document !== "undefined" ? document.createElement("div") : null;

function textOf(html: string): string {
  if (!scratch) return html.replace(/<[^>]+>/g, "");
  scratch.innerHTML = html;
  return scratch.textContent ?? "";
}

export function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, "\n");
}

/** Split a markdown body into top-level blocks rendered independently. */
export function lexBlocks(body: string): Block[] {
  const src = normalizeBody(body);
  const tokens = marked.lexer(src) as TokensList;
  const out: Block[] = [];
  for (const token of tokens) {
    if (token.type === "space") {
      out.push({ raw: token.raw, html: "", text: "", type: "space" });
      continue;
    }
    const list = [token] as unknown as TokensList;
    list.links = tokens.links;
    const rendered = marked.parser(list);
    const html = DOMPurify.sanitize(rendered, { ADD_ATTR: ["data-target"] });
    out.push({ raw: token.raw, html, text: textOf(html), type: token.type });
  }
  return out;
}

export function joinBlocks(blocks: Block[]): string {
  return blocks.map((b) => b.raw).join("");
}

/** Render a whole body at once (used for lightweight views). */
export function renderMarkdown(body: string): string {
  const rendered = marked.parse(normalizeBody(body)) as string;
  return DOMPurify.sanitize(rendered, { ADD_ATTR: ["data-target"] });
}

/** Resolve a wiki-link target to a page path within the session. */
export function resolveWikiTarget(target: string, paths: Iterable<string>): string | null {
  const t = target.trim().replace(/\.md$/i, "").toLowerCase();
  for (const p of paths) {
    const base = p.replace(/\.md$/i, "").toLowerCase();
    if (base === t || base.split("/").pop() === t) return p;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A pattern that finds `text` in markdown source even when the source is
 * hard-wrapped or uses different runs of whitespace.
 */
export function flexiblePattern(text: string): RegExp | null {
  const parts = text.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!parts.length) return null;
  // Leading/trailing whitespace in `text` is part of the match (a reverted insertion must take its space with it).
  const lead = /^\s/.test(text) ? "\\s+" : "";
  const trail = /\s$/.test(text) ? "\\s+" : "";
  return new RegExp(lead + parts.join("\\s+") + trail);
}

/** Replaces the first flexible match of `text` in `raw`, or returns null when absent. */
export function replaceFlexible(raw: string, text: string, replacement: string | ((match: string) => string)): string | null {
  const re = flexiblePattern(text);
  if (!re || !re.test(raw)) return null;
  // A function replacer keeps `$` in the replacement literal.
  return raw.replace(re, (m) => (typeof replacement === "function" ? replacement(m) : replacement));
}

/** Wraps the first occurrence of `text` in `raw` with a wiki-link, keeping the source's own spelling of it. */
export function linkTextInRaw(raw: string, text: string, target: string): string | null {
  return replaceFlexible(raw, text, (m) => `[[${target}|${m}]]`);
}
