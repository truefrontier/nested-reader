import { test } from "node:test";
import assert from "node:assert/strict";
import { createUnique, slugify, titleFromQuestion, uniquePath } from "./slug";

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

/** A folder on disk, as `write_new_page` sees it: it refuses a name already there, in any case. */
function disk(files: string[]) {
  const onDisk = new Set(files.map((f) => f.toLowerCase()));
  const tried: string[] = [];
  const create = async (path: string) => {
    tried.push(path);
    if (onDisk.has(path.toLowerCase())) return false;
    onDisk.add(path.toLowerCase());
    return true;
  };
  return { create, tried };
}

test("createUnique skips a name that is on disk but not yet in the app's list", async () => {
  const { create, tried } = disk(["notes/sleep.md", "notes/sleep-2.md"]);
  const path = await createUnique("sleep", new Set(["notes/sleep-3.md"]), "notes", create);
  assert.equal(path, "notes/sleep-4.md");
  assert.deepEqual(tried, ["notes/sleep.md", "notes/sleep-2.md", "notes/sleep-4.md"]);
});

test("createUnique writes the first name when nothing is in the way", async () => {
  const { create, tried } = disk([]);
  assert.equal(await createUnique("sleep", new Set(), "", create), "sleep.md");
  assert.deepEqual(tried, ["sleep.md"]);
});

test("createUnique gives up with a plain error after a few taken names", async () => {
  const { create, tried } = disk(["Sleep.md", "sleep-2.md", "sleep-3.md", "sleep-4.md", "sleep-5.md"]);
  await assert.rejects(createUnique("sleep", new Set(), "", create), {
    message: "Couldn't make the page: sleep.md and the next 4 names after it are already in the folder.",
  });
  assert.equal(tried.length, 5);
});
