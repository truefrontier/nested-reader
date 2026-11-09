import { test } from "node:test";
import assert from "node:assert/strict";
import { findWikiLink, flexiblePattern, isStubBody, joinBlocks, keepLinksInReader, lexBlocks, linkTextInRaw, renderInline, replaceFlexible, resolveWikiTarget, withLineEndings } from "./markdown";

test("joinBlocks gives back the body lexBlocks split, byte for byte", () => {
  const body = "\n# Title\n\nFirst paragraph\nhard-wrapped.\n\n- one\n- two\n\n```js\nx = 1\n```\n\n\nLast.";
  assert.equal(joinBlocks(lexBlocks(body)), body);
  assert.deepEqual(lexBlocks(body).filter((b) => b.type !== "space").map((b) => b.type), ["heading", "paragraph", "list", "code", "paragraph"]);
});

test("a wiki link renders as a link to its target with its own text", () => {
  const [block] = lexBlocks("See [[sleep-replay|replay]] here.");
  assert.match(block.html, /<a class="wl" href="#" data-target="sleep-replay">replay<\/a>/);
  assert.equal(block.text, "See replay here.\n");
});

test("a mermaid fence stays as inert source text", () => {
  const [block] = lexBlocks("```mermaid\ngraph TD; A-->B\n```");
  assert.match(block.html, /^<div class="mermaid-block"><pre class="mermaid-source"><code class="language-mermaid">graph TD; A--&gt;B<\/code><\/pre><\/div>/);
});

test("resolveWikiTarget matches a page by path or by file name, ignoring case and .md", () => {
  const paths = ["notes/Sleep-Replay.md", "other.md"];
  assert.equal(resolveWikiTarget("sleep-replay", paths), "notes/Sleep-Replay.md");
  assert.equal(resolveWikiTarget("Notes/sleep-replay.md", paths), "notes/Sleep-Replay.md");
  assert.equal(resolveWikiTarget("missing", paths), null);
});

test("flexiblePattern finds text across a hard wrap and keeps its edge whitespace", () => {
  assert.equal(flexiblePattern("   "), null);
  assert.ok(flexiblePattern("sharp wave ripples")?.test("sharp\nwave   ripples"));
  assert.equal(replaceFlexible("a sharp\nwave b", " sharp wave ", " X "), "a X b");
  assert.equal(replaceFlexible("abc", "zzz", "y"), null);
});

test("replaceFlexible keeps dollar signs in the replacement literal", () => {
  assert.equal(replaceFlexible("cost here", "here", "$1 and $&"), "cost $1 and $&");
});

test("linkTextInRaw and findWikiLink agree on where a link went", () => {
  const raw = linkTextInRaw("Ripples replay\nmemories.\n", "replay memories", "replay");
  assert.equal(raw, "Ripples [[replay|replay\nmemories]].\n");
  assert.deepEqual(findWikiLink("# T\n\n" + raw, "replay"), { block: 2, text: "replay\nmemories" });
  assert.equal(findWikiLink("No links.", "replay"), null);
});

test("isStubBody is true only for a page that holds nothing but its heading", () => {
  assert.equal(isStubBody("# Title\n\n"), true);
  assert.equal(isStubBody("   "), true);
  assert.equal(isStubBody("# Title\n\nA paragraph."), false);
});

test("renderInline keeps inline markup and the text's own line breaks", () => {
  assert.equal(renderInline("**bold** and `code`\r\nnext"), "<strong>bold</strong> and <code>code</code>\nnext");
});

/** Links one word the way the store does: lex, change one block, join, then put the body's endings back. */
function linkOneWord(body: string, block: number, word: string): string {
  const blocks = lexBlocks(body);
  blocks[block] = { ...blocks[block], raw: linkTextInRaw(blocks[block].raw, word, "sleep-replay")! };
  return withLineEndings(joinBlocks(blocks), body);
}

test("a CRLF body comes back byte for byte, with only the edited block changed", () => {
  const body = "# Sleep\r\n\r\nRipples carry the day\r\nout to the cortex.\r\n\r\n- one\r\n- two\r\n";
  assert.equal(withLineEndings(joinBlocks(lexBlocks(body)), body), body);
  assert.equal(linkOneWord(body, 2, "Ripples"), body.replace("Ripples", "[[sleep-replay|Ripples]]"));
});

test("an LF body stays LF", () => {
  const body = "# Sleep\n\nRipples carry the day.\n";
  assert.equal(linkOneWord(body, 2, "Ripples"), "# Sleep\n\n[[sleep-replay|Ripples]] carry the day.\n");
});

test("a file that mixes endings comes back all in the one it uses more", () => {
  // Two CRLF lines to one LF line, so the LF line becomes CRLF; the reverse comes back all LF.
  assert.equal(linkOneWord("# Sleep\r\n\r\nRipples.\n", 2, "Ripples"), "# Sleep\r\n\r\n[[sleep-replay|Ripples]].\r\n");
  assert.equal(linkOneWord("# Sleep\n\nRipples.\r\n", 2, "Ripples"), "# Sleep\n\n[[sleep-replay|Ripples]].\n");
});

test("withLineEndings turns a whole LF text into CRLF for a CRLF body, front matter and all", () => {
  assert.equal(withLineEndings("---\ntitle: Sleep\n---\n\n# Sleep\n", "# Sleep\r\n"), "---\r\ntitle: Sleep\r\n---\r\n\r\n# Sleep\r\n");
  assert.equal(withLineEndings("# Sleep\n", ""), "# Sleep\n");
});

/** An element as DOMPurify's hook sees it, holding only what the hook reads and writes. */
function element(nodeName: string, attrs: Record<string, string>, namespaceURI = "http://www.w3.org/1999/xhtml") {
  const held = new Map(Object.entries(attrs));
  const node = {
    nodeName,
    tagName: nodeName,
    namespaceURI,
    getAttribute: (name: string) => held.get(name) ?? null,
    setAttribute: (name: string, value: string) => void held.set(name, value),
    removeAttribute: (name: string) => void held.delete(name),
  };
  keepLinksInReader(node as unknown as Element);
  return Object.fromEntries(held);
}

test("a web link opens in the browser, and links the browser can't be handed lose their address", () => {
  assert.deepEqual(element("A", { href: "https://example.com/" }), { href: "https://example.com/", target: "_blank", rel: "noopener noreferrer" });
  assert.deepEqual(element("A", { class: "wl", href: "#", "data-target": "x" }), { class: "wl", href: "#", "data-target": "x" });
  // An image map's area, and an SVG link, would take the window itself to the site.
  assert.deepEqual(element("AREA", { shape: "rect", coords: "0,0,9,9", href: "https://attacker.example/" }), { shape: "rect", coords: "0,0,9,9" });
  const svg = "http://www.w3.org/2000/svg";
  assert.deepEqual(element("a", { href: "https://attacker.example/" }, svg), {});
  assert.deepEqual(element("a", { "xlink:href": "https://attacker.example/" }, svg), {});
});
