import { test } from "node:test";
import assert from "node:assert/strict";
import { closedVersionView, initialUi, uiAfterNavigate } from "./ui";
import type { Lookup, Selection, UiState } from "./store";

const highlight = (pane: "main" | "split"): Selection => ({ pane, block: 2, start: 0, end: 5, text: "Sharp", paragraph: "Sharp waves", caretX: 40 });
/** A key set to undefined and a key left out mean the same to the app. */
const defined = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const card: Lookup = { pane: "split", block: 1, thread: [], question: "why?", answer: "because", streaming: false };

test("a highlight in the split pane, and the box open on it, stay when the main pane moves", () => {
  const ui: UiState = { ...initialUi, selection: highlight("split"), popover: "refine" };
  const after = uiAfterNavigate(ui, {});
  assert.deepEqual(after.selection, highlight("split"));
  assert.equal(after.popover, "refine");
});

test("a highlight in the main pane, and its box, go with the page they were on", () => {
  const after = uiAfterNavigate({ ...initialUi, selection: highlight("main"), popover: "ask" }, {});
  assert.equal(after.selection, undefined);
  assert.equal(after.popover, undefined);
});

test("the split pane's version view stays, and the main pane's closes", () => {
  const ui: UiState = { ...initialUi, versionView: { main: { history: true, viewing: 3, confirmRestore: true }, split: { history: false, viewing: 2, confirmRestore: false } } };
  assert.deepEqual(uiAfterNavigate(ui, {}).versionView, { main: closedVersionView, split: { history: false, viewing: 2, confirmRestore: false } });
});

test("the answer cards are the ones the caller kept", () => {
  const ui: UiState = { ...initialUi, lookups: { "main:1": { ...card, pane: "main" }, "split:1": card } };
  assert.deepEqual(uiAfterNavigate(ui, { "split:1": card }).lookups, { "split:1": card });
});

test("what follows the work rather than the page stays; what belongs to the old page goes", () => {
  const undo = { label: "Undo", run: () => {} };
  const ui: UiState = {
    ...initialUi,
    filter: "ripple",
    unreadOnly: true,
    changesOnly: true,
    refines: { "refine#1": { path: "a.md", pages: ["a.md"], scope: "page", text: "shorter" } },
    lastPopoverMode: "refine",
    panePopover: "feedback",
    feedbackMessage: "half a note",
    feedbackEmail: "me@example.com",
    toastAction: undo,
    error: "Deleted a.md",
    map: "web",
    find: true,
    findQuery: "replay",
    fullscreen: true,
  };
  assert.deepEqual(defined(uiAfterNavigate(ui, {})), {
    ...initialUi,
    filter: "ripple",
    unreadOnly: true,
    changesOnly: true,
    refines: ui.refines,
    lastPopoverMode: "refine",
    panePopover: "feedback",
    feedbackMessage: "half a note",
    feedbackEmail: "me@example.com",
    toastAction: undo,
    error: "Deleted a.md",
  });
  // A plain error, with nothing to offer, was about the old page.
  assert.equal(uiAfterNavigate({ ...initialUi, error: "Couldn't read a.md" }, {}).error, undefined);
});
