import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { queryTerms, rankByRelevance, words } from "./rank";

test("words lowercases, drops stop words and single letters, and folds plurals", () => {
  assert.deepEqual(words("The Ripples of Classes and Studies, glasses: a boss's gas I x"), ["ripple", "class", "study", "glass", "boss", "gas"]);
});

// One table for both sides: tools.rs's tests read this same file, so the two can't fold apart.
const plurals = JSON.parse(readFileSync(new URL("./plurals.json", import.meta.url), "utf8")) as [string, string[]][];

test("words folds a plural onto its singular and leaves words that only look plural (plurals.json)", () => {
  for (const [text, want] of plurals) assert.deepEqual(words(text), want, text);
});

// `search_pages` in tools.rs must cut text into the same words; its test checks these same lines.
test("words keeps vowel signs inside a word and counts characters, as tools.rs does", () => {
  assert.deepEqual(words("किताबें 𝔸 ok"), ["किताबें", "ok"]);
});

test("queryTerms keeps each word once, in the order typed", () => {
  assert.deepEqual(queryTerms("ripple Ripples RIPPLE sleep"), ["ripple", "sleep"]);
});

type Doc = { title: string; body: string };
const rank = (terms: string[], docs: Doc[]) =>
  rankByRelevance(terms, docs, (d) => d.body, (d) => d.title).map((d) => d.title);

test("rankByRelevance puts the best match first and drops pages that share no word", () => {
  const docs = [
    { title: "Bread", body: "Sourdough crumb." },
    { title: "Sleep", body: "Ripples during sleep." },
    { title: "Ripples", body: "Ripples, more ripples." },
  ];
  assert.deepEqual(rank(["ripple"], docs), ["Ripples", "Sleep"]);
});

test("rankByRelevance keeps the caller's order for ties and for an empty query", () => {
  const docs = [{ title: "One", body: "same words" }, { title: "Two", body: "same words" }];
  assert.deepEqual(rank(["word"], docs), ["One", "Two"]);
  assert.deepEqual(rank([], [{ title: "B", body: "" }, { title: "A", body: "" }]), ["B", "A"]);
});

test("rankByRelevance drops a lone page that shares no word, as it does with two", () => {
  assert.deepEqual(rank(["ripple"], [{ title: "Bread", body: "Sourdough." }]), []);
  assert.deepEqual(rank(["ripple"], [{ title: "Ripples", body: "" }]), ["Ripples"]);
});
