import { test } from "node:test";
import assert from "node:assert/strict";
import { listStep, moveFocus, pressOnKey, STAND_IN, trackInput, treeKey, type TreeRow } from "./keys";

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

/** `trackInput` on a stand-in window: its listeners, a root with a dataset, and elements that count blurs. */
function inputWatch() {
  const on: Record<string, (e: object) => void> = {};
  const root = { dataset: {} as DOMStringMap };
  trackInput({ addEventListener: (type: string, fn: (e: object) => void) => void (on[type] = fn) } as unknown as EventTarget, root);
  const el = (selector: string | null) => {
    const seen = { blurs: 0 };
    return { seen, matches: (sel: string) => sel === selector, closest: () => null, blur: () => void seen.blurs++ };
  };
  return { on, root, el };
}

test("a pointer press clears the keyboard mark, and Tab or a key outside a text box sets it", () => {
  const { on, root } = inputWatch();
  on.keydown({ key: "j", target: { closest: () => null } });
  assert.equal(root.dataset.kb, "");
  on.pointerdown({});
  assert.equal("kb" in root.dataset, false);
  on.keydown({ key: "j", target: { closest: () => ({}) } });
  assert.equal("kb" in root.dataset, false, "typing in a text box doesn't count");
  on.keydown({ key: "Tab", target: { closest: () => ({}) } });
  assert.equal(root.dataset.kb, "");
});

test("focus a pointer press puts on a stand-in button goes back, and keyboard focus stays", () => {
  const { on, el } = inputWatch();
  const span = el(STAND_IN);
  on.pointerdown({});
  on.focusin({ target: span });
  assert.equal(span.seen.blurs, 1, "focused by the press");
  on.pointerup({});
  on.focusin({ target: span });
  assert.equal(span.seen.blurs, 1, "focused by code after the press (a menu's first item)");
  on.pointerdown({});
  on.keydown({ key: "Tab", target: { closest: () => null } });
  on.focusin({ target: span });
  assert.equal(span.seen.blurs, 1, "a key ends the press");
  const box = el(null);
  on.pointerdown({});
  on.focusin({ target: box });
  assert.equal(box.seen.blurs, 0, "a real button or text box keeps the focus a click gives");
});
