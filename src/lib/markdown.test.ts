import { test } from "node:test";
import assert from "node:assert/strict";
import { findWikiLink, flexiblePattern, isStubBody, joinBlocks, lexBlocks, linkTextInRaw, renderInline, replaceFlexible, resolveWikiTarget } from "./markdown";

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
