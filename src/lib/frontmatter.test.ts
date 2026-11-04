import { test } from "node:test";
import assert from "node:assert/strict";
import { metaFromRaw, parseFrontMatter, serializeFrontMatter, serializePage, titleFromBody, titleFromPath } from "./frontmatter";

test("a page saved and read back has the body it was saved with", () => {
  const body = "# Replay\n\nSharp-wave ripples.\n";
  const meta = { path: "replay.md", title: "Replay", source: "sleep.md", created: "2026-01-01T00:00:00Z" };
  let raw = serializePage(meta, body);
  assert.equal(raw, '---\ntitle: Replay\nsource: sleep.md\ncreated: "2026-01-01T00:00:00Z"\n---\n\n# Replay\n\nSharp-wave ripples.\n');
  // Every edit to a page loaded from disk saves the body it read, so the round trip must be exact.
  for (let i = 0; i < 3; i++) {
    const read: string = metaFromRaw("replay.md", raw).body;
    assert.equal(read, body, `round trip ${i + 1}`);
    raw = serializePage(meta, read);
  }
});

test("parseFrontMatter takes the values serializeFrontMatter quotes back exactly", () => {
  const meta = { title: 'Why "replay"?', question: "a: b # c", source: " padded ", note: "it's", multi: "one\ntwo" };
  const { meta: back, body } = parseFrontMatter(serializeFrontMatter(meta) + "Text");
  assert.deepEqual(back, meta);
  assert.equal(body, "Text");
});

test("parseFrontMatter reads YAML single quotes, CRLF fences, and leaves a page without front matter alone", () => {
  assert.deepEqual(parseFrontMatter("---\r\ntitle: 'It''s here'\r\n---\r\n\r\nBody").meta, { title: "It's here" });
  assert.equal(parseFrontMatter("---\r\ntitle: x\r\n---\r\n\r\nBody").body, "Body");
  assert.deepEqual(parseFrontMatter("Just text\n---\n"), { meta: {}, body: "Just text\n---\n" });
  // A hand-written file with no blank line after the fence keeps its first line.
  assert.equal(parseFrontMatter("---\ntitle: x\n---\n# Heading\n").body, "# Heading\n");
});

test("serializeFrontMatter skips empty values and writes nothing when none are left", () => {
  assert.equal(serializeFrontMatter({ title: "", source: undefined }), "");
  assert.equal(serializeFrontMatter({ title: "T", source: undefined }), "---\ntitle: T\n---\n\n");
});

test("titleFromBody takes the first level-1 heading", () => {
  assert.equal(titleFromBody("Intro\n\n## Sub\n\n#   Main title  \n\n# Second\n", "fb"), "Main title");
  assert.equal(titleFromBody("No heading here", "fb"), "fb");
});

test("titleFromBody skips a shell comment inside a code fence", () => {
  assert.equal(titleFromBody("Intro\n\n```bash\n# install deps\nnpm i\n```\n\n# Real title\n", "fb"), "Real title");
  assert.equal(titleFromBody("~~~\n# not this\n~~~\n", "fb"), "fb");
});

test("titleFromBody does not take the next line as the text of an empty heading", () => {
  assert.equal(titleFromBody("#\nSome text\n", "fb"), "fb");
});

test("titleFromPath turns a file name into words", () => {
  assert.equal(titleFromPath("notes/sharp-wave_ripples.md"), "Sharp wave ripples");
  assert.equal(titleFromPath("README.MD"), "README");
});

test("metaFromRaw falls back from front matter to heading to file name, and only keeps known modes", () => {
  const a = metaFromRaw("x/deep-sleep.md", "---\nmode: sideways\n---\n\nplain", "2026-02-02T00:00:00Z");
  assert.deepEqual(a.meta, { path: "x/deep-sleep.md", title: "Deep sleep", source: undefined, question: undefined, created: undefined, modified: "2026-02-02T00:00:00Z", mode: undefined });
  assert.equal(metaFromRaw("p.md", "# From heading\n").meta.title, "From heading");
  assert.equal(metaFromRaw("p.md", "---\ntitle: From meta\nmode: deep-dive\n---\n\n# Heading").meta.mode, "deep-dive");
});
