import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type Settings } from "../platform/types";
import { unmaskDataUris } from "./dataUris";
import { newFileMessages, parseSummaries, quickAnswerMessages, refineMessages, summaryMessages, SUMMARY_PAGE_CHARS, type AskContext, type ContextPage } from "./prompts";

/** True when `s` holds half of a surrogate pair, which the backend's JSON parser rejects outright. */
const torn = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

function page(path: string, body: string, title = path): ContextPage {
  return { meta: { path, title }, body };
}

function ctx(over: Partial<AskContext> = {}, context: Partial<Settings["context"]> = {}): AskContext {
  return {
    page: page("current.md", "# Current\n\nThe page being read."),
    session: [],
    folder: [],
    settings: { ...DEFAULT_SETTINGS, tools: false, context: { ...DEFAULT_SETTINGS.context, ...context } },
    ...over,
  };
}

test("parseSummaries reads numbered lines back into their slots and drops what does not parse", () => {
  const text = "Here you go:\n1. First page.\n3) Third   page.\n2 . Second page.\n9. Out of range.\n1. A repeat.\n";
  assert.deepEqual(parseSummaries(text, 4), ["First page.", "Second page.", "Third page.", undefined]);
});

test("parseSummaries for one page strips a stray number but keeps a sentence that starts with one", () => {
  assert.deepEqual(parseSummaries("1. Ripples replay waking sequences.", 1), ["Ripples replay waking sequences."]);
  assert.deepEqual(parseSummaries("1.5 GB of sleep recordings, scored by hand.", 1), ["1.5 GB of sleep recordings, scored by hand."]);
  assert.deepEqual(parseSummaries("   ", 1), [undefined]);
});

test("summaryMessages numbers the pages and asks for one line each", () => {
  const { system, messages } = summaryMessages([{ title: "A", body: "alpha" }, { title: "B", body: "beta" }]);
  assert.match(system, /one numbered line per page/);
  assert.equal(messages[0].content, "Page 1: A\nalpha\n\n---\n\nPage 2: B\nbeta");
  assert.match(summaryMessages([{ title: "A", body: "alpha" }]).system, /that one sentence and nothing else/);
});

test("summaryMessages never cuts an emoji in half at the page limit", () => {
  const body = "a".repeat(SUMMARY_PAGE_CHARS - 1) + "😀 and more";
  const { messages } = summaryMessages([{ title: "T", body }]);
  assert.equal(torn(messages[0].content), false);
});

test("a long page is clipped without leaving half an emoji in the prompt", () => {
  const body = "a".repeat(11_999) + "😀" + "b".repeat(100);
  const { messages } = quickAnswerMessages(ctx({ page: page("current.md", body) }), "What?");
  assert.equal(torn(messages[0].content), false);
  assert.match(messages[0].content, /a\n…\n\nQuestion: What\?$/);
});

test("quickAnswerMessages replays an inline thread as alternating turns", () => {
  const { messages } = quickAnswerMessages(ctx({ thread: [{ question: "Q1", answer: "A1" }, { question: "Q2", answer: "A2" }] }), "Q3");
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.match(messages[0].content, /^Current page: current\.md\n# Current/);
  assert.match(messages[0].content, /Question: Q1$/);
  assert.deepEqual(messages.slice(1).map((m) => m.content), ["A1", "Question: Q2", "A2", "Question: Q3"]);
});

test("an empty question asks to explain the highlight", () => {
  const { messages } = quickAnswerMessages(ctx({ selection: "sharp-wave ripples" }), "");
  assert.match(messages[0].content, /Highlighted text:\nsharp-wave ripples/);
  assert.match(messages[0].content, /Question: Explain: sharp-wave ripples$/);
});

test("folder pages go in only when Settings allows them, best match first, unrelated ones left out", () => {
  const folder = [page("bread.md", "Sourdough starter and crumb.", "Bread"), page("sleep.md", "Ripples during sleep.", "Sleep"), page("ripples.md", "Ripples, ripples and more ripples.", "Ripples")];
  const off = quickAnswerMessages(ctx({ folder }), "ripples").messages[0].content;
  assert.doesNotMatch(off, /Folder page/);
  const on = quickAnswerMessages(ctx({ folder }, { folder: true }), "ripples").messages[0].content;
  assert.deepEqual([...on.matchAll(/Folder page: (\w+)/g)].map((m) => m[1]), ["Ripples", "Sleep"]);
});

test("session pages go in nearest first when the session context is on", () => {
  const session = [page("near.md", "near body", "Near"), page("far.md", "far body", "Far")];
  const on = quickAnswerMessages(ctx({ session }), "anything").messages[0].content;
  assert.deepEqual([...on.matchAll(/Session page: (\w+)/g)].map((m) => m[1]), ["Near", "Far"]);
  assert.doesNotMatch(quickAnswerMessages(ctx({ session }, { session: false }), "anything").messages[0].content, /Session page/);
});

test("embedded images never reach the model, and a rewrite's mask puts them back", () => {
  const img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
  const text = `Before ![dot](${img}) after.`;
  const { messages, mask } = refineMessages(ctx({ page: page("current.md", text) }), "Tighten it", "page", text);
  assert.doesNotMatch(messages[0].content, /data:image/);
  const echoed = messages[0].content.split("Text to rewrite:\n")[1];
  assert.deepEqual(unmaskDataUris(mask, echoed), { ok: true, text });
});

test("a ⌘N page leaves out the highlight even when one is set", () => {
  const { messages } = newFileMessages(ctx({ selection: "stale selection", paragraph: "stale paragraph" }), "A page on sleep", false);
  assert.doesNotMatch(messages[0].content, /stale/);
  assert.match(messages[0].content, /New page: A page on sleep$/);
});
