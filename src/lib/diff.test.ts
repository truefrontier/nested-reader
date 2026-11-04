import { test } from "node:test";
import assert from "node:assert/strict";
import { diffBodies, revertChange } from "./diff";

const spans = (oldBody: string, newBody: string) => diffBodies(oldBody, newBody).changes.map((c) => [c.before, c.after]);

test("diffBodies finds nothing between equal bodies", () => {
  assert.deepEqual(diffBodies("# T\n\nSame.\n", "# T\n\nSame.\n").changes, []);
});

test("diffBodies reports a changed word with its offsets in both texts", () => {
  const [c] = diffBodies("Ripples replay memories.\n", "Ripples consolidate memories.\n").changes;
  assert.deepEqual([c.before, c.after, c.oldStart, c.oldEnd, c.start, c.end], ["replay", "consolidate", 8, 14, 8, 19]);
});

test("diffBodies folds a short unchanged gap into one change and keeps far-apart edits separate", () => {
  assert.deepEqual(spans("alpha beta gamma.\n", "alpha BETA, GAMMA.\n"), [["beta gamma", "BETA, GAMMA"]]);
  assert.deepEqual(spans("one two three four five six.\n", "ONE two three four five SIX.\n"), [["one", "ONE"], ["six", "SIX"]]);
});

test("diffBodies reports a whole block added or removed", () => {
  assert.deepEqual(spans("A.\n\nC.\n", "A.\n\nB.\n\nC.\n"), [["", "B.\n"]]);
  assert.deepEqual(spans("A.\n\nB.\n\nC.\n", "A.\n\nC.\n"), [["B.\n", ""]]);
});

test("revertChange swaps one word back and leaves the rest of the page", () => {
  const oldBody = "# T\n\nRipples replay\nmemories.\n\nOther **bold** text.\n";
  const newBody = "# T\n\nRipples consolidate\nmemories.\n\nOther **bold** text.\n";
  const diff = diffBodies(oldBody, newBody);
  assert.equal(revertChange(diff, diff.changes[0]), oldBody);
});

test("revertChange puts a removed block back where it was", () => {
  const oldBody = "A.\n\nB.\n\nC.\n";
  const diff = diffBodies(oldBody, "A.\n\nC.\n");
  assert.equal(revertChange(diff, diff.changes[0]), oldBody);
});

test("reverting a deleted word keeps the other edit in the same paragraph", () => {
  const diff = diffBodies("One alpha beta gamma delta epsilon.\n", "One alpha gamma delta EPSILON.\n");
  assert.deepEqual(diff.changes.map((c) => [c.before, c.after]), [["beta ", ""], ["epsilon", "EPSILON"]]);
  assert.equal(revertChange(diff, diff.changes[0]), "One alpha beta gamma delta EPSILON.\n");
  assert.equal(revertChange(diff, diff.changes[1]), "One alpha gamma delta epsilon.\n");
});

test("a deleted word goes back between the words that pin it, keeping a second edit nearby", () => {
  // Each body has a second edit, so restoring the whole old block would show up as a failure.
  const revertDeletion = (oldBody: string, newBody: string) => {
    const diff = diffBodies(oldBody, newBody);
    const deletion = diff.changes.find((c) => c.after === "");
    if (!deletion) throw new Error("expected a pure deletion");
    return revertChange(diff, deletion);
  };
  // "the " is on the page twice, so the anchor grows to "and the ".
  assert.equal(revertDeletion("the cat and the big dog sat.\n", "the cat and the dog SAT.\n"), "the cat and the big dog SAT.\n");
  // The word before is wrapped in markup, so the word after pins it.
  assert.equal(revertDeletion("One **alpha** beta gamma end.\n", "One **alpha** gamma END.\n"), "One **alpha** beta gamma END.\n");
  assert.equal(revertDeletion("Start here now please.\n", "here now PLEASE.\n"), "Start here now PLEASE.\n");
  assert.equal(revertDeletion("It ends here today.\n", "IT ends here.\n"), "IT ends here today.\n");
});
