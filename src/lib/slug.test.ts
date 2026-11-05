import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, titleFromQuestion, uniquePath } from "./slug";

test("slugify folds accents and punctuation into dashes", () => {
  assert.equal(slugify("Café Über — Notes!"), "cafe-uber-notes");
  assert.equal(slugify("  Why do we sleep?  "), "why-do-we-sleep");
});

test("slugify falls back to page when nothing usable is left", () => {
  assert.equal(slugify("!!!"), "page");
  assert.equal(slugify("睡眠"), "page");
});

test("slugify keeps to 60 characters with no dash left dangling", () => {
  const s = slugify("a".repeat(59) + " bcd");
  assert.equal(s, "a".repeat(59));
});

test("titleFromQuestion tidies spacing and capitalises the first letter", () => {
  assert.equal(titleFromQuestion("  why   do we\nsleep? "), "Why do we sleep?");
  assert.equal(titleFromQuestion("   "), "Untitled");
});

test("uniquePath numbers a name that is taken, inside the chosen subfolder", () => {
  assert.equal(uniquePath("note", new Set()), "note.md");
  assert.equal(uniquePath("note", new Set(["notes/note.md", "notes/note-2.md"]), "notes/"), "notes/note-3.md");
});

test("uniquePath treats a name that differs only in case as taken", () => {
  // macOS volumes ignore case, so writing sleep.md would replace the reader's own Sleep.md.
  assert.equal(uniquePath("sleep", new Set(["Sleep.md"])), "sleep-2.md");
  assert.equal(uniquePath("readme", new Set(["README.md", "readme-2.md"])), "readme-3.md");
});
