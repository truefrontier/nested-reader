import { test } from "node:test";
import assert from "node:assert/strict";
import type { PageMeta } from "../platform/types";
import { fingerprint, sessionMap, sessionMapForPrompt, summaryIsCurrent } from "./sessionmap";

const meta = (path: string, title: string, extra: Partial<PageMeta> = {}): PageMeta => ({ path, title, ...extra });

test("fingerprint changes with the text and is stable for the same text", () => {
  assert.equal(fingerprint("alpha"), fingerprint("alpha"));
  assert.notEqual(fingerprint("alpha"), fingerprint("alphb"));
  assert.equal(typeof fingerprint(""), "string");
});

test("summaryIsCurrent only holds for the text the line was written for", () => {
  const cache = { "a.md": { about: "x", for: fingerprint("old") } };
  assert.equal(summaryIsCurrent(cache, "a.md", "old"), true);
  assert.equal(summaryIsCurrent(cache, "a.md", "new"), false);
  assert.equal(summaryIsCurrent(cache, "b.md", "old"), false);
});

test("sessionMap lists pages by path with what is known about each", () => {
  const pages = [
    meta("b.md", "Bee", { source: "a.md" }),
    meta("a.md", "Ay", { question: "Why sleep?" }),
  ];
  const map = sessionMap(pages, { "a.md": { about: "Sleep consolidates memory.", for: "f" } }, { "a.md": 1, "b.md": 3 });
  const [, ...entries] = map.split("\n\n");
  assert.match(map, /^# Session map\n\d{4}-\d{2}-\d{2} · 2 pages\n\n/);
  assert.deepEqual(entries, [
    "## a.md — Ay\nasks: Why sleep?\nabout: Sleep consolidates memory.\n1 revision",
    "## b.md — Bee\nfrom: a.md · 3 revisions",
  ]);
  assert.match(sessionMap([], {}), /· 0 pages\n\nNothing in the session yet\.$/);
});

test("sessionMapForPrompt leaves out the page already quoted and stays within budget", () => {
  const pages = Array.from({ length: 40 }, (_, i) => meta(`page-${String(i).padStart(2, "0")}.md`, `Page number ${i} about sleep`));
  const out = sessionMapForPrompt(pages, {}, "sleep", 1_000, "page-00.md");
  assert.ok(out.length <= 1_000, `length ${out.length}`);
  assert.doesNotMatch(out, /page-00\.md/);
  assert.match(out, /^# Session map\n39 other pages in the session\./);
  assert.match(out, /…and \d+ more; the tools can list them all\.$/);
});

test("sessionMapForPrompt describes the pages nearest the question first", () => {
  const pages = [meta("bread.md", "Bread"), meta("ripples.md", "Ripples", { question: "What are ripples?" })];
  const out = sessionMapForPrompt(pages, {}, "ripples", 6_000);
  assert.ok(out.indexOf("## ripples.md") >= 0);
  assert.ok(out.indexOf("## ripples.md") < out.indexOf("bread.md"));
  assert.equal(sessionMapForPrompt([meta("a.md", "A")], {}, "x", 6_000, "a.md"), "");
});

test("sessionMapForPrompt counts a single page left over in the singular", () => {
  const long = meta("long.md", "L".repeat(300));
  const out = sessionMapForPrompt([long], {}, "", 200);
  assert.match(out, /Another 1 page is in the session; the tools can list it\.$/);
});
