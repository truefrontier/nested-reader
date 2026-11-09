import { test } from "node:test";
import assert from "node:assert/strict";
import { gripKey, isPress, listStep, moveFocus, pressOnKey, treeKey, typeAhead, type TreeRow } from "./keys";

// Node has no DOM. These stand-ins do what the DOM does for the calls keys.ts makes: an event that
// records whether it was stopped, and elements that set `document.activeElement` when focused.

function keyEvent(key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}, from?: object) {
  const seen = { clicks: 0, prevented: false, stopped: false };
  const span = { click: () => void seen.clicks++ };
  const e = {
    key,
    metaKey: !!mods.metaKey,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    target: from ?? span,
    currentTarget: span,
    preventDefault: () => void (seen.prevented = true),
    stopPropagation: () => void (seen.stopped = true),
  };
  return { e, seen };
}

test("Enter and Space press a span that stands in for a button, and go no further", () => {
  for (const key of ["Enter", " "]) {
    const { e, seen } = keyEvent(key);
    pressOnKey(e);
    assert.deepEqual(seen, { clicks: 1, prevented: true, stopped: true }, key);
  }
});

test("other keys, and Enter with a modifier, leave the span alone for the window", () => {
  for (const [key, mods] of [["a", {}], ["Tab", {}], ["Escape", {}], ["Enter", { metaKey: true }], [" ", { altKey: true }], ["Enter", { ctrlKey: true }]] as const) {
    const { e, seen } = keyEvent(key, mods);
    pressOnKey(e);
    assert.deepEqual(seen, { clicks: 0, prevented: false, stopped: false }, `${key} ${JSON.stringify(mods)}`);
  }
});

test("isPress is Enter or Space with no modifier, the test a page mark's keys go through", () => {
  const press = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) => isPress({ key, metaKey: !!mods.metaKey, ctrlKey: !!mods.ctrlKey, altKey: !!mods.altKey });
  assert.deepEqual([press("Enter"), press(" "), press("a"), press("Tab"), press("Enter", { metaKey: true }), press(" ", { ctrlKey: true }), press("Enter", { altKey: true })], [true, true, false, false, false, false, false]);
});

test("Enter on something focused inside the span (a menu item, a rename box) is not the span's", () => {
  const { e, seen } = keyEvent("Enter", {}, { tagName: "BUTTON" });
  pressOnKey(e);
  assert.deepEqual(seen, { clicks: 0, prevented: false, stopped: false });
});

test("listStep moves through a menu and wraps at both ends", () => {
  assert.equal(listStep("ArrowDown", 3, -1), 0);
  assert.equal(listStep("ArrowDown", 3, 0), 1);
  assert.equal(listStep("ArrowDown", 3, 2), 0);
  assert.equal(listStep("ArrowUp", 3, 0), 2);
  assert.equal(listStep("ArrowUp", 3, -1), 2);
  assert.equal(listStep("ArrowRight", 3, 1), 2);
  assert.equal(listStep("ArrowLeft", 3, 1), 0);
  assert.equal(listStep("Home", 3, 2), 0);
  assert.equal(listStep("End", 3, 0), 2);
  assert.equal(listStep("Enter", 3, 0), null);
  assert.equal(listStep("ArrowDown", 0, -1), null);
});

test("moveFocus focuses the next matching item from the one that has focus", () => {
  type Item = { name: string; focus(): void };
  const doc: { activeElement: Item | null } = { activeElement: null };
  Object.assign(globalThis, { document: doc });
  const items: Item[] = ["Rename", "Reveal", "Delete"].map((name) => {
    const it: Item = { name, focus: () => void (doc.activeElement = it) };
    return it;
  });
  const asked: string[] = [];
  const menu = {
    querySelectorAll: (sel: string) => {
      asked.push(sel);
      return items;
    },
  } as unknown as ParentNode;

  assert.equal((moveFocus(menu, "[role=menuitem]", "ArrowDown") as unknown as { name: string }).name, "Rename");
  assert.equal(doc.activeElement?.name, "Rename");
  moveFocus(menu, "[role=menuitem]", "ArrowDown");
  assert.equal(doc.activeElement?.name, "Reveal");
  moveFocus(menu, "[role=menuitem]", "End");
  assert.equal(doc.activeElement?.name, "Delete");
  moveFocus(menu, "[role=menuitem]", "ArrowDown");
  assert.equal(doc.activeElement?.name, "Rename");
  assert.equal(moveFocus(menu, "[role=menuitem]", "x"), null);
  assert.equal(doc.activeElement?.name, "Rename");
  assert.deepEqual([...new Set(asked)], ["[role=menuitem]"]);
  assert.equal(moveFocus(null, "[role=menuitem]", "ArrowDown"), null);
});

// The sidebar as the keyboard sees it:
//   0 ▸ notes/            (folder, open)
//   1     Why the brain replays the day
//   2       Replay into cortex        (hangs under 1)
//   3   ▸ drafts/          (folder, closed)
//   4 Sleep memory          (a page in the session folder itself)
const ROWS: TreeRow[] = [{ level: 1, expanded: true }, { level: 2 }, { level: 3 }, { level: 2, expanded: false }, { level: 1 }];

test("↑ and ↓ move one row and stop at the ends; Home and End jump there", () => {
  assert.deepEqual(treeKey("ArrowDown", false, ROWS, 0), { focus: 1 });
  assert.deepEqual(treeKey("ArrowDown", false, ROWS, 4), null);
  assert.deepEqual(treeKey("ArrowUp", false, ROWS, 1), { focus: 0 });
  assert.deepEqual(treeKey("ArrowUp", false, ROWS, 0), null);
  assert.deepEqual(treeKey("Home", false, ROWS, 3), { focus: 0 });
  assert.deepEqual(treeKey("End", false, ROWS, 1), { focus: 4 });
});

test("→ opens a closed folder, then steps into an open one or a page's first child", () => {
  assert.deepEqual(treeKey("ArrowRight", false, ROWS, 3), { expand: 3 });
  assert.deepEqual(treeKey("ArrowRight", false, ROWS, 0), { focus: 1 });
  assert.deepEqual(treeKey("ArrowRight", false, ROWS, 1), { focus: 2 });
  assert.deepEqual(treeKey("ArrowRight", false, ROWS, 2), null);
  assert.deepEqual(treeKey("ArrowRight", false, ROWS, 4), null);
});

test("← closes an open folder, otherwise steps out to the row it hangs under", () => {
  assert.deepEqual(treeKey("ArrowLeft", false, ROWS, 0), { collapse: 0 });
  assert.deepEqual(treeKey("ArrowLeft", false, ROWS, 2), { focus: 1 });
  assert.deepEqual(treeKey("ArrowLeft", false, ROWS, 1), { focus: 0 });
  assert.deepEqual(treeKey("ArrowLeft", false, ROWS, 3), { focus: 0 });
  assert.deepEqual(treeKey("ArrowLeft", false, ROWS, 4), null);
});

test("Enter and Space open the row; ⇧F10 and the context-menu key open its menu", () => {
  assert.deepEqual(treeKey("Enter", false, ROWS, 2), { activate: 2 });
  assert.deepEqual(treeKey(" ", false, ROWS, 3), { activate: 3 });
  assert.deepEqual(treeKey("F10", true, ROWS, 1), { menu: 1 });
  assert.deepEqual(treeKey("F10", false, ROWS, 1), null);
  assert.deepEqual(treeKey("ContextMenu", false, ROWS, 4), { menu: 4 });
});

test("keys the tree doesn't use, and a row that isn't there, do nothing", () => {
  assert.equal(treeKey("a", false, ROWS, 1), null);
  assert.equal(treeKey("Tab", false, ROWS, 1), null);
  assert.equal(treeKey("ArrowDown", false, ROWS, -1), null);
  assert.equal(treeKey("ArrowDown", false, [], 0), null);
});

test("gripKey moves a resize handle a step, five with ⇧, and stops at the ends", () => {
  const range = { min: 180, max: 480 };
  assert.equal(gripKey("ArrowRight", false, 224, range, 16, "ArrowRight"), 240);
  assert.equal(gripKey("ArrowLeft", false, 224, range, 16, "ArrowRight"), 208);
  assert.equal(gripKey("ArrowRight", true, 224, range, 16, "ArrowRight"), 304);
  assert.equal(gripKey("ArrowLeft", true, 224, range, 16, "ArrowRight"), 180);
  assert.equal(gripKey("ArrowRight", false, 476, range, 16, "ArrowRight"), 480);
  assert.equal(gripKey("Home", false, 300, range, 16, "ArrowRight"), 180);
  assert.equal(gripKey("End", false, 300, range, 16, "ArrowRight"), 480);
});

test("gripKey takes its direction from `grow`, and ignores the other axis and other keys", () => {
  const range = { min: 0, max: 1000 };
  // The split pane sits right of (or below) its handle, so ← (or ↑) makes it bigger.
  assert.equal(gripKey("ArrowLeft", false, 400, range, 24, "ArrowLeft"), 424);
  assert.equal(gripKey("ArrowRight", false, 400, range, 24, "ArrowLeft"), 376);
  assert.equal(gripKey("ArrowUp", false, 400, range, 24, "ArrowUp"), 424);
  assert.equal(gripKey("ArrowDown", false, 400, range, 24, "ArrowUp"), 376);
  assert.equal(gripKey("ArrowUp", false, 400, range, 24, "ArrowLeft"), null);
  assert.equal(gripKey("ArrowRight", false, 400, range, 24, "ArrowUp"), null);
  assert.equal(gripKey("Enter", false, 400, range, 24, "ArrowLeft"), null);
  assert.equal(gripKey("a", false, 400, range, 24, "ArrowLeft"), null);
});

test("gripKey keeps the minimum when a small window leaves no room for both panes", () => {
  assert.equal(gripKey("ArrowLeft", false, 300, { min: 260, max: 200 }, 24, "ArrowLeft"), 260);
  assert.equal(gripKey("End", false, 300, { min: 260, max: 200 }, 24, "ArrowLeft"), 260);
});

const NAMES = ["Why the brain replays the day", "Replay into cortex", "Does replay run the other way?", "Slow oscillations", "Sharp-wave ripples", "Same order"];

test("typeAhead jumps to the next name with the typed letter, wrapping, and steps on with each press", () => {
  assert.equal(typeAhead(NAMES, 0, "s"), 3);
  assert.equal(typeAhead(NAMES, 3, "s"), 4);
  assert.equal(typeAhead(NAMES, 4, "ss"), 5);
  assert.equal(typeAhead(NAMES, 5, "sss"), 3);
  assert.equal(typeAhead(NAMES, -1, "w"), 0);
  assert.equal(typeAhead(NAMES, 0, "W"), 0);
});

test("typeAhead matches a longer prefix from the row it is on, and finds nothing for a prefix no name has", () => {
  assert.equal(typeAhead(NAMES, 3, "sl"), 3);
  assert.equal(typeAhead(NAMES, 3, "sa"), 5);
  assert.equal(typeAhead(NAMES, 0, "replay i"), 1);
  assert.equal(typeAhead(NAMES, 0, "z"), -1);
  assert.equal(typeAhead(NAMES, 0, ""), -1);
  assert.equal(typeAhead([], 0, "s"), -1);
});
