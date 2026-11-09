/**
 * Keyboard paths for the reader's controls. Many are spans and divs styled to look just so; these
 * helpers give them what a real button, menu or tree does for the keyboard and a screen reader,
 * without changing how they look to the mouse. Kept free of React so `node --test` can drive them.
 */

/** The parts of a React or DOM key event that `pressOnKey` reads. */
export type PressEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: unknown;
  currentTarget: { click(): void };
  preventDefault(): void;
  stopPropagation(): void;
};

/**
 * Enter or Space presses a span or div that stands in for a button, as they press a real one. The key
 * stops there, so the window's ↵ (which retries a failed page) doesn't also fire, and Space doesn't
 * scroll. With ⌘, ⌃ or ⌥ held the key is left alone for the window's shortcuts, and a key that
 * comes up from something focused inside (a menu item, a rename box) is that thing's to handle.
 */
export function pressOnKey(e: PressEvent): void {
  if (!isPress(e) || e.target !== e.currentTarget) return;
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.click();
}

/** Enter or Space with no ⌘, ⌃ or ⌥: the keys that press a button. */
export function isPress(e: Pick<PressEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  return (e.key === "Enter" || e.key === " ") && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** Spread on a clickable span or div to make it a button for the keyboard and a screen reader. */
export const PRESS = { role: "button", tabIndex: 0, onKeyDown: pressOnKey } as const;

/**
 * Where ↓ → (next), ↑ ← (previous), Home and End move in a list of `count` items from `at` (-1 when
 * none has focus), wrapping at the ends, as a menu, radio group or tab list does. Null for other keys.
 */
export function listStep(key: string, count: number, at: number): number | null {
  if (!count) return null;
  const last = count - 1;
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return last;
    case "ArrowDown":
    case "ArrowRight":
      return at < 0 || at >= last ? 0 : at + 1;
    case "ArrowUp":
    case "ArrowLeft":
      return at <= 0 ? last : at - 1;
  }
  return null;
}

/** Moves focus among the items in `container` that match `selector`, by `listStep`. Returns the item focused, or null. */
export function moveFocus(container: ParentNode | null | undefined, selector: string, key: string): HTMLElement | null {
  const items = [...(container?.querySelectorAll<HTMLElement>(selector) ?? [])];
  const next = listStep(key, items.length, items.indexOf(document.activeElement as HTMLElement));
  if (next === null) return null;
  items[next].focus();
  return items[next];
}

/** A row of the sidebar tree as the keyboard sees it: its `aria-level`, and for a folder whether it is open. */
export type TreeRow = { level: number; expanded?: boolean };

/** What a key does on the tree row at an index. */
export type TreeMove = { focus: number } | { expand: number } | { collapse: number } | { activate: number } | { menu: number };

/**
 * The tree pattern (WAI-ARIA APG): ↑ ↓ move a row, Home and End go to the ends, → opens a closed
 * folder or steps into the first row under one, ← closes an open folder or steps out to the row
 * above it in the tree, Enter and Space open the row, and ⇧F10 or the context-menu key opens its ⋯ menu.
 */
export function treeKey(key: string, shiftKey: boolean, rows: TreeRow[], at: number): TreeMove | null {
  const row = rows[at];
  if (!row) return null;
  switch (key) {
    case "ArrowDown":
      return at < rows.length - 1 ? { focus: at + 1 } : null;
    case "ArrowUp":
      return at > 0 ? { focus: at - 1 } : null;
    case "Home":
      return { focus: 0 };
    case "End":
      return { focus: rows.length - 1 };
    case "ArrowRight":
      if (row.expanded === false) return { expand: at };
      return (rows[at + 1]?.level ?? 0) > row.level ? { focus: at + 1 } : null;
    case "ArrowLeft":
      if (row.expanded === true) return { collapse: at };
      for (let i = at - 1; i >= 0; i--) if (rows[i].level < row.level) return { focus: i };
      return null;
    case "Enter":
    case " ":
      return { activate: at };
    case "F10":
      return shiftKey ? { menu: at } : null;
    case "ContextMenu":
      return { menu: at };
  }
  return null;
}

/**
 * Where an arrow key moves a resize handle (a `separator`): `step` per press, five steps with ⇧, Home and
 * End to the ends of `range`. `grow` is the arrow that makes the value bigger, its opposite shrinks it,
 * and the other two arrows do nothing. Null for keys the handle doesn't use. The result is kept in
 * `range`, with `min` winning when the range is upside down (a window too small for both panes).
 */
export function gripKey(key: string, shiftKey: boolean, value: number, range: { min: number; max: number }, step: number, grow: "ArrowRight" | "ArrowLeft" | "ArrowDown" | "ArrowUp"): number | null {
  const shrink = { ArrowRight: "ArrowLeft", ArrowLeft: "ArrowRight", ArrowDown: "ArrowUp", ArrowUp: "ArrowDown" }[grow];
  const by = shiftKey ? step * 5 : step;
  const next = key === "Home" ? range.min : key === "End" ? range.max : key === grow ? value + by : key === shrink ? value - by : null;
  return next === null ? null : Math.max(range.min, Math.min(range.max, next));
}

/**
 * Type-ahead in a list or tree: the index of the first name starting with `query` (any case), looking
 * from `at` onward and wrapping, or -1 when none does. One letter, or the same letter typed again
 * ("ss"), starts after `at`, so each press steps to the next name with that letter, as Finder does.
 */
export function typeAhead(names: string[], at: number, query: string): number {
  const q = query.toLowerCase();
  if (!q || !names.length) return -1;
  const same = [...q].every((c) => c === q[0]);
  const needle = same ? q[0] : q;
  const from = Math.max(0, same ? at + 1 : at);
  for (let i = 0; i < names.length; i++) {
    const j = (from + i) % names.length;
    if (names[j].toLowerCase().startsWith(needle)) return j;
  }
  return -1;
}

/**
 * Who is driving, kept on `root` (the `<html>` element) and the focus a click gives:
 * - `data-kb` is set on Tab, or on a key pressed outside a text box (/ to the filter, ⌘F to find), and
 *   cleared by a pointer press. Text boxes show their focus ring only under it (app.css), since they match
 *   `:focus-visible` on a click too. Typing inside a box doesn't count.
 * - The spans and divs that stand in for buttons (`PRESS`) took no focus before they had a tabindex, so a
 *   click on one left it on the body, where ↵ reaches the window (and retries a failed page). A click
 *   focuses an element with a tabindex, so the focus a pointer press puts on one (`STAND_IN`) goes back to
 *   the body. Real buttons, links and text boxes, tree rows (Sidebar decides those) and the resize edges keep theirs.
 */
export const STAND_IN = "[tabindex]:not(a, button, input, select, textarea, [contenteditable], [role=treeitem], [role=separator])";
export function trackInput(win: Pick<EventTarget, "addEventListener">, root: { dataset: DOMStringMap }): void {
  // True from a pointer press until it is let go: the focus a press gives is the click's, not the keyboard's.
  let pressing = false;
  const on = (type: string, fn: (e: Event) => void) => win.addEventListener(type, fn, true);
  on("keydown", (e) => {
    pressing = false;
    const t = e.target as Element | null;
    if ((e as KeyboardEvent).key === "Tab" || !t?.closest?.("input, textarea, [contenteditable]")) root.dataset.kb = "";
  });
  on("pointerdown", () => {
    pressing = true;
    delete root.dataset.kb;
  });
  on("pointerup", () => (pressing = false));
  on("pointercancel", () => (pressing = false));
  on("focusin", (e) => {
    const t = e.target as HTMLElement | null;
    if (pressing && t?.matches?.(STAND_IN)) t.blur();
  });
}
